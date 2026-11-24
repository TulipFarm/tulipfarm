import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserInput } from '@tulipfarm/browser/contracts';
import { browserViewport } from '@tulipfarm/browser/contracts';
import { inputModifiers, typedText, viewportPoint } from './screen-input';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  browserApi,
  browserErrorMessage,
  browserFrameSchema,
  browserSessionStateSchema,
  type BrowserSessionState,
} from './api';
import { loadedLoginPrompt, SaveLoginDialog, SignInPicker } from './login-picker';
import { siteOfPage } from './logins';

const startingMs = 60_000;
const maxRefusals = 5;

export const handBackPrompt = 'I’ve finished in the browser. Continue.';

type Live =
  | { kind: 'connecting' }
  | { kind: 'closed' }
  | { kind: 'error'; message: string }
  | { kind: 'open'; state: BrowserSessionState };

const buttons = ['left', 'middle', 'right'] as const;

/** The live screen of a chat's browser. The member can take over to act on the page, then hand back. */
export function LiveBrowserCanvas({
  workspaceId,
  chatId,
  onHandBack,
}: {
  workspaceId: string;
  chatId: string;
  onHandBack: (prompt: string) => void;
}) {
  const api = useMemo(() => browserApi(workspaceId, chatId), [workspaceId, chatId]);
  const [live, setLive] = useState<Live>({ kind: 'connecting' });
  const [frame, setFrame] = useState<{ data: string; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  // The site a member took over to sign in to, so they can save the login when they hand back.
  const signingIn = useRef<string | null>(null);
  // The panel can open while the agent's first browser action is still starting the browser.
  const opening = useRef({ since: 0, seen: false, refused: 0 });

  useEffect(() => {
    opening.current = { since: Date.now(), seen: false, refused: 0 };
  }, [api]);

  useEffect(() => {
    setLive({ kind: 'connecting' });
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource(api.liveUrl, { withCredentials: true });
    source.addEventListener('state', event => {
      const parsed = browserSessionStateSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      if (!parsed.success) return;
      opening.current.seen = true;
      opening.current.refused = 0;
      setLive({ kind: 'open', state: parsed.data });
    });
    source.addEventListener('frame', event => {
      const parsed = browserFrameSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
      if (parsed.success) setFrame(parsed.data);
    });
    // The stream ends every few minutes and reconnects by itself. A closed or missing browser ends it for good.
    source.addEventListener('error', () => {
      api.state(controller.signal).then(
        state => {
          if (state) {
            // A refused stream does not reconnect by itself, though the browser has opened since.
            if (source.readyState !== EventSource.CLOSED) return;
            const refused = ++opening.current.refused;
            if (refused > maxRefusals) setLive({ kind: 'error', message: browserErrorMessage(null) });
            else retry = setTimeout(() => setAttempt(value => value + 1), 1_000 * 2 ** (refused - 1));
            return;
          }
          source.close();
          if (!opening.current.seen && Date.now() - opening.current.since < startingMs) {
            retry = setTimeout(() => setAttempt(value => value + 1), 2_000);
            return;
          }
          setLive({ kind: 'closed' });
        },
        failure => {
          if (controller.signal.aborted) return;
          source.close();
          setLive({ kind: 'error', message: browserErrorMessage(failure) });
        },
      );
    });
    return () => {
      controller.abort();
      clearTimeout(retry);
      source.close();
    };
  }, [api, attempt]);

  const state = live.kind === 'open' ? live.state : null;
  const inControl = state?.controller === 'person';

  const decide = async (controller: 'person' | 'agent') => {
    setBusy(true);
    setError('');
    try {
      const signIn = state?.signIn ?? null;
      const next = await api.control(controller);
      if (next) setLive({ kind: 'open', state: next });
      if (controller === 'person') signingIn.current = signIn;
      if (controller === 'agent') {
        onHandBack(handBackPrompt);
        const site = signingIn.current;
        signingIn.current = null;
        if (site && !state?.logins.some(login => login.site === site)) setSaving(site);
      }
    } catch (failure) {
      setError(browserErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  // Inputs go one at a time so a click lands before the keys typed after it.
  const queue = useRef(Promise.resolve());
  const send = useCallback(
    (input: BrowserInput) => {
      queue.current = queue.current.then(
        () => api.input(input),
        () => api.input(input),
      );
      queue.current.catch(failure => setError(browserErrorMessage(failure)));
    },
    [api],
  );

  const screen = useRef<HTMLDivElement>(null);
  const size = frame ?? browserViewport;
  useEffect(() => {
    const element = screen.current;
    if (!element || !inControl) return;
    let pending: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = viewportPoint(element.getBoundingClientRect(), event.clientX, event.clientY, size);
      const first = !pending;
      pending = {
        ...point,
        deltaX: (pending?.deltaX ?? 0) + event.deltaX,
        deltaY: (pending?.deltaY ?? 0) + event.deltaY,
      };
      if (!first) return;
      setTimeout(() => {
        const clamp = (value: number) => Math.max(-5000, Math.min(5000, value));
        if (pending) send({ type: 'wheel', ...pending, deltaX: clamp(pending.deltaX), deltaY: clamp(pending.deltaY) });
        pending = null;
      }, 80);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [inControl, send, size]);

  const pointer = (event: React.PointerEvent<HTMLDivElement>, type: 'mousePressed' | 'mouseReleased') => {
    if (!inControl) return;
    event.preventDefault();
    if (type === 'mousePressed') event.currentTarget.focus();
    const point = viewportPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, size);
    send({
      type: 'mouse',
      event: type,
      ...point,
      button: buttons[event.button] ?? 'left',
      clickCount: Math.min(Math.max(event.detail, 1), 3),
      modifiers: inputModifiers(event),
    });
  };
  const key = (event: React.KeyboardEvent<HTMLDivElement>, type: 'keyDown' | 'keyUp') => {
    if (!inControl || event.key.length > 64) return;
    // Let the person paste with the usual shortcut; the paste event sends the text.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    event.preventDefault();
    const text = typedText(event);
    send({
      type: 'key',
      event: type,
      key: event.key,
      code: event.code.slice(0, 64),
      ...(type === 'keyDown' && text ? { text } : {}),
      modifiers: inputModifiers(event),
    });
  };

  if (live.kind === 'connecting')
    return (
      <CanvasSection title="Browser" meta="Connecting…">
        <Skeleton shape="panel" />
      </CanvasSection>
    );
  if (live.kind === 'closed')
    return (
      <CanvasSection title="Browser">
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="The browser has closed"
          description="It closes after 10 minutes without use. Ask the agent to open it again."
        />
      </CanvasSection>
    );
  if (live.kind === 'error')
    return (
      <CanvasSection title="Browser">
        <StatePanel kind="error" heading="h3" title="Couldn’t show the browser" description={live.message}>
          <Button
            variant="outline"
            onClick={() => {
              opening.current = { since: Date.now(), seen: false, refused: 0 };
              setAttempt(value => value + 1);
            }}
          >
            Try again
          </Button>
        </StatePanel>
      </CanvasSection>
    );

  const page = live.state;
  return (
    <CanvasSection
      title={page.title || 'Browser'}
      meta={page.url}
      actions={
        <>
          {siteOfPage(page.url) && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSaving(siteOfPage(page.url))}>
              Save login
            </Button>
          )}
          {inControl ? (
            <Button size="sm" disabled={busy} onClick={() => void decide('agent')}>
              Hand back to the agent
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void decide('person')}>
              Take over
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {saving !== null && (
          <SaveLoginDialog workspaceId={workspaceId} chatId={chatId} site={saving} close={() => setSaving(null)} />
        )}
        {page.signIn && page.needsPerson && !inControl && (
          <SignInPicker
            workspaceId={workspaceId}
            chatId={chatId}
            site={page.signIn}
            reason={page.needsPerson}
            busy={busy}
            onTakeOver={() => void decide('person')}
            onLoaded={next => {
              setLive({ kind: 'open', state: next });
              onHandBack(loadedLoginPrompt(page.signIn ?? ''));
            }}
          />
        )}
        {page.needsPerson && !page.signIn && !inControl && (
          <Alert>
            <AlertTitle>The agent needs you</AlertTitle>
            <AlertDescription>{page.needsPerson} Take over, finish this step, then hand back.</AlertDescription>
          </Alert>
        )}
        {inControl && (
          <p role="status" className="text-xs text-muted-foreground">
            You’re in control. The agent waits until you hand back.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div
          ref={screen}
          role="application"
          aria-label={inControl ? 'Browser screen. Click and type to use the page.' : 'Browser screen'}
          aria-roledescription="remote browser"
          tabIndex={inControl ? 0 : -1}
          onPointerDown={event => pointer(event, 'mousePressed')}
          onPointerUp={event => pointer(event, 'mouseReleased')}
          onContextMenu={event => inControl && event.preventDefault()}
          onKeyDown={event => key(event, 'keyDown')}
          onKeyUp={event => key(event, 'keyUp')}
          onPaste={event => {
            if (!inControl) return;
            event.preventDefault();
            const text = event.clipboardData.getData('text/plain').slice(0, 2000);
            if (text) send({ type: 'text', text });
          }}
          className={
            inControl
              ? 'overflow-hidden rounded-md border border-ring bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring'
              : 'overflow-hidden rounded-md border border-border bg-muted'
          }
        >
          {frame ? (
            <img
              src={`data:image/jpeg;base64,${frame.data}`}
              alt={`Live view of ${page.title || page.url}`}
              draggable={false}
              className={
                inControl ? 'block h-auto w-full cursor-pointer select-none' : 'block h-auto w-full select-none'
              }
            />
          ) : (
            <Skeleton shape="panel" />
          )}
        </div>
      </div>
    </CanvasSection>
  );
}

export const liveBrowserCanvasId = (chatId: string) => `live-browser:${chatId}`;
export const isBrowserTool = (tool: string) => tool === 'browser.act' || tool === 'browser.handoff';
