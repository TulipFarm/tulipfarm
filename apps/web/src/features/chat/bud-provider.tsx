import { shouldOpenBudOnboarding } from './bud-state';
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Maximize2Icon, MinusIcon } from 'lucide-react';
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { budStateSchema, type BudState } from '@tulipfarm/conversations/bud-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { featureKey, freshness, useFeatureRead } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { onWindowReturn } from '@/lib/window-return';
import { workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { Popover, PopoverContent, PopoverTitle, PopoverDescription } from '@tulipfarm/sprout/popover';
import { TulipAvatar } from '@/components/tulip-avatar';
import { bud } from '@tulipfarm/conversations/avatar';
import { BudContext, type BudCommand } from './bud-context';
import { ChatHeaderContext } from './header-context';
import { createRecommendationStream } from './recommendation-stream';
import { sourcePickerHash } from './recommendations';
import { budCornerClasses, nearestBudCorner, useBudPosition } from './bud-position';
import { useConversationChanges } from './queries';

const BudChat = lazy(() => import('./private-conversations').then(module => ({ default: module.BudConversation })));
const key = ['bud'] as const;
class BudRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(workspaceId: string, signal: AbortSignal, command?: BudCommand): Promise<BudState> {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/bud`, {
    signal: requestSignal(signal),
    cache: 'no-store',
    ...(command ? { method: 'POST', body: command } : {}),
  });
  const body = await readJson(response);
  if (!response.ok) throw new BudRequestError(response.status, responseError(body, 'bud-unavailable'));
  return budStateSchema.parse(body);
}
async function load(workspaceId: string, signal: AbortSignal) {
  try {
    const state = await request(workspaceId, signal);
    return state.onboarding === 'active' ? request(workspaceId, signal, { kind: 'sync' }) : state;
  } catch (error) {
    if (error instanceof BudRequestError && error.message === 'bud-not-initialized')
      return request(workspaceId, signal, { kind: 'bootstrap' });
    throw error;
  }
}
const canInterrupt = () =>
  document.visibilityState === 'visible' &&
  !Array.from(document.querySelectorAll('[role="dialog"]')).some(dialog => dialog.getClientRects().length > 0) &&
  !(
    document.activeElement instanceof HTMLElement &&
    document.activeElement.matches('input,textarea,[contenteditable="true"]')
  );

export function BudProvider({ children, headerActions }: { children: ReactNode; headerActions: HTMLElement | null }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { runtime, scope, current } = useFeatureContext();
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: location => location.pathname });
  const globalHeader = useContext(ChatHeaderContext);
  const docked = pathname === `/${workspace.slug}/calendar`;
  const changes = useConversationChanges();
  const read = useFeatureRead({
    key,
    load: signal => load(workspace.id, signal),
    staleTime: freshness.chat,
    pollWhile: data =>
      data.onboarding === 'active' ||
      data.preferences.some(item => item.status === 'asking' || item.status === 'proposed'),
    interval: 15_000,
    maxChecks: 120,
  });
  const data = read.state.kind === 'ready' ? read.state.data : null;
  const [open, setOpen] = useState(false);
  const position = useBudPosition();
  const dock = useRef<HTMLElement | null>(null);
  const launcher = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; wasOpen: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [mainHost, setMainHost] = useState<HTMLDivElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const [parkingHost, setParkingHost] = useState<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failure =
    error ??
    (read.state.kind === 'error' || (read.state.kind === 'ready' && read.state.error)
      ? 'Bud could not load. Reload Bud to try again.'
      : null);
  const writing = useRef(false);
  const mounted = useRef(true);
  const redirected = useRef(false);
  const navigated = useRef(false);
  useEffect(
    () =>
      router.history.subscribe(() => {
        navigated.current = true;
      }),
    [router],
  );
  const returnKey = `bud-return:${workspace.id}:${scope.kind === 'workspace' ? scope.membershipId : scope.userId}`;
  const returnFromSetup = useCallback(() => {
    const destination = sessionStorage.getItem(returnKey);
    sessionStorage.removeItem(returnKey);
    router.history.replace(destination?.startsWith(`/${workspace.slug}/`) ? destination : `/${workspace.slug}`);
  }, [returnKey, router, workspace.slug]);
  const [container] = useState(() => {
    const element = document.createElement('div');
    element.dataset.budConversation = '';
    element.className = 'flex min-h-0 flex-1 flex-col';
    return element;
  });
  const full = !!data?.conversationId && pathname === `/${workspace.slug}/chat/${data.conversationId}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const command = useCallback(
    async (input: BudCommand) => {
      if (writing.current || !current()) return null;
      writing.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await request(workspace.id, new AbortController().signal, input);
        if (!mounted.current || !current()) return null;
        runtime.client.setQueryData(featureKey(scope, key), next);
        return next;
      } catch (cause) {
        if (mounted.current && current()) {
          setError(
            cause instanceof BudRequestError && cause.message === 'credits-exhausted'
              ? 'Bud needs workspace credits to start a reply. Add credits, then try again.'
              : cause instanceof BudRequestError && cause.status === 409
                ? 'This changed before it could be saved. Reload Bud and review the current value.'
                : 'Bud could not finish that action. Your input is still here. Try again.',
          );
          if (cause instanceof BudRequestError && [401, 403, 404].includes(cause.status))
            runtime.client.removeQueries({ queryKey: featureKey(scope, key), exact: true });
        }
        return null;
      } finally {
        writing.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [workspace.id, current, runtime, scope],
  );
  useEffect(() => {
    const stream = createRecommendationStream(
      `${apiOrigin}/v1/workspaces/${workspace.id}/recommendations/events`,
      { workspaceId: workspace.id, membershipId: scope.kind === 'workspace' ? scope.membershipId : '' },
      kind => {
        if (!current()) return;
        if (kind === 'conceal')
          runtime.client.setQueryData<BudState>(featureKey(scope, key), previous =>
            previous ? { ...previous, nudge: null } : previous,
          );
        void runtime.applyChange(scope, { kind: 'change', keys: [key] });
      },
    );
    const sync = () => {
      if (document.visibilityState === 'hidden') stream.stop();
      else if (current()) stream.start();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      stream.stop();
    };
  }, [workspace.id, scope, current, runtime]);
  useEffect(
    () =>
      onWindowReturn(() => {
        void read.refresh();
      }),
    [read.refresh],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void read.refresh();
    }, 30 * 60_000);
    return () => clearInterval(timer);
  }, [data?.nudge?.fingerprint, read.refresh]);
  useEffect(() => {
    if (!data || redirected.current) return;
    redirected.current = true;
    if (
      data.conversationId &&
      shouldOpenBudOnboarding({
        onboarding: data.onboarding,
        conversationId: data.conversationId,
        search: window.location.search,
        navigated: navigated.current,
      })
    ) {
      if (!full) sessionStorage.setItem(returnKey, `${pathname}${window.location.hash}`);
      void navigate({
        to: '/$workspaceSlug/chat/$chatId',
        params: { workspaceSlug: workspace.slug, chatId: data.conversationId },
        replace: true,
      });
    }
  }, [data, navigate, workspace.slug, full, pathname, returnKey]);
  useEffect(() => {
    if (full && data?.onboarding === 'skipped' && sessionStorage.getItem(returnKey)) returnFromSetup();
  }, [full, data?.onboarding, returnFromSetup, returnKey]);
  useEffect(() => {
    if (!data?.nudge || data.nudge.presented || full || open || busy || error) return;
    const fingerprint = data.nudge.fingerprint;
    const show = () => {
      if (canInterrupt()) void command({ kind: 'present', fingerprint });
    };
    const timer = window.setInterval(show, 1000);
    show();
    document.addEventListener('focusout', show);
    document.addEventListener('visibilitychange', show);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('focusout', show);
      document.removeEventListener('visibilitychange', show);
    };
  }, [data?.nudge, full, open, busy, error, command]);
  useLayoutEffect(() => {
    const host = full ? mainHost : (panelHost ?? parkingHost);
    if (host) host.appendChild(container);
    return () => {
      container.remove();
    };
  }, [full, mainHost, panelHost, parkingHost, container]);
  useEffect(() => {
    if (full) setOpen(false);
  }, [full]);
  const reveal = async () => {
    const next = data?.conversationId ? data : await command({ kind: 'open' });
    if (next?.conversationId) setOpen(true);
  };
  const movePointer = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const x = event.clientX - start.x,
      y = event.clientY - start.y;
    if (!start.moved && Math.hypot(x, y) < 8) return;
    if (!start.moved) setOpen(false);
    start.moved = true;
    if (dock.current) dock.current.style.transform = `translate(${x}px,${y}px)`;
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    if (dock.current) dock.current.style.transform = '';
    if (start.moved) {
      suppressClick.current = true;
      if (!cancel) position.move(nearestBudCorner(event.clientX, event.clientY, window.innerWidth, window.innerHeight));
      if (start.wasOpen) setOpen(true);
    }
  };
  const nudge = data?.nudge?.presented ? data.nudge : null;
  const acceptNudge = async () => {
    if (!nudge) return;
    const next = await command({ kind: 'open-nudge', fingerprint: nudge.fingerprint });
    if (!next) return;
    if (nudge.action.kind === 'open')
      void navigate({
        to: `/$workspaceSlug/${nudge.action.destination}`,
        params: { workspaceSlug: workspace.slug },
        hash: nudge.action.sourcePicker ? sourcePickerHash[nudge.action.sourcePicker] : '',
      });
    else {
      setOpen(true);
      if (next.conversationId) void changes.created(next.conversationId);
    }
  };
  const context = useMemo(
    () => ({
      state: data,
      busy,
      error: failure,
      command,
      refresh: () => {
        setError(null);
        void read.refresh();
      },
      returnFromSetup,
      mainHost: setMainHost,
    }),
    [data, busy, failure, command, read.refresh, returnFromSetup],
  );
  const suggestion = nudge && !open && (
    <section aria-label="Bud suggestion" className="rounded-xl border bg-popover p-3 text-sm shadow-lg">
      <p>{nudge.question}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void acceptNudge()}>
          Let's do it
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void command({ kind: 'dismiss', fingerprint: nudge.fingerprint })}
        >
          Dismiss
        </Button>
      </div>
    </section>
  );
  const failureNotice = failure && (
    <div role="alert" className="rounded-lg border bg-popover p-2 text-sm">
      <p>{failure}</p>
      <Button size="sm" variant="ghost" onClick={context.refresh}>
        Reload Bud
      </Button>
    </div>
  );
  const launcherDock = !full && (
    <aside
      ref={dock}
      aria-label="Bud assistant"
      data-corner={docked ? 'header' : position.corner}
      className={
        docked
          ? 'relative z-40 flex items-center'
          : `fixed z-40 flex max-w-xs flex-col gap-2 ${budCornerClasses[position.corner]}`
      }
    >
      {docked
        ? (suggestion || failureNotice) && (
            <div className="fixed inset-x-4 top-14 z-50 grid gap-2 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72">
              {suggestion}
              {failureNotice}
            </div>
          )
        : suggestion}
      <Button
        ref={launcher}
        variant={docked ? 'ghost' : 'outline'}
        size={docked ? 'calendar' : 'bud-labeled'}
        aria-label={open ? 'Minimize Bud' : 'Open Bud'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          docked
            ? 'Your separate private quick chat'
            : 'Your separate private quick chat. Drag to move to another corner.'
        }
        disabled={busy || read.state.kind === 'loading'}
        onPointerDown={event => {
          if (docked || event.button !== 0 || !event.isPrimary) return;
          suppressClick.current = false;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, wasOpen: open };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={movePointer}
        onPointerUp={event => finishDrag(event)}
        onPointerCancel={event => finishDrag(event, true)}
        onLostPointerCapture={event => finishDrag(event, true)}
        onClick={event => {
          if (suppressClick.current && event.detail !== 0) {
            suppressClick.current = false;
            return;
          }
          suppressClick.current = false;
          if (open) setOpen(false);
          else void reveal();
        }}
      >
        <TulipAvatar
          name={bud.name}
          character={bud.character}
          color={bud.color}
          view={bud.view}
          state={nudge ? 'Listening' : 'Idle'}
          size={docked ? 24 : 32}
          variant="plain"
        />
        {docked ? (
          <span className="hidden md:inline">Bud</span>
        ) : (
          <span className="flex flex-col items-start">
            <span>{open ? 'Close quick chat' : 'Bud quick chat'}</span>
            <span className="text-xs font-normal text-muted-foreground">Separate private chat</span>
          </span>
        )}
      </Button>
      {!docked && failureNotice}
    </aside>
  );
  return (
    <BudContext value={context}>
      {children}
      <div hidden ref={setParkingHost} />
      {docked ? headerActions && createPortal(launcherDock, headerActions) : launcherDock}
      <Popover
        open={open && !full}
        modal={false}
        onOpenChange={(next, details) => {
          if (
            !next &&
            details.reason === 'outside-press' &&
            details.event.target instanceof Node &&
            launcher.current?.contains(details.event.target)
          ) {
            details.cancel();
            return;
          }
          setOpen(next);
        }}
      >
        <PopoverContent
          size="bud"
          keepMounted
          anchor={launcher}
          finalFocus={launcher}
          side={docked || position.corner.startsWith('top') ? 'bottom' : 'top'}
          align={docked || position.corner.endsWith('left') ? 'start' : 'end'}
          sideOffset={8}
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <PopoverTitle>Bud quick chat</PopoverTitle>
              <PopoverDescription>Your separate private chat</PopoverDescription>
            </div>
            <div className="flex items-center gap-1">
              {data?.conversationId && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Open full chat"
                  title="Open full chat"
                  onClick={() =>
                    void navigate({
                      to: '/$workspaceSlug/chat/$chatId',
                      params: { workspaceSlug: workspace.slug, chatId: data.conversationId! },
                    })
                  }
                >
                  <Maximize2Icon />
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Minimize chat"
                title="Minimize chat"
                onClick={() => setOpen(false)}
              >
                <MinusIcon />
              </Button>
            </div>
          </header>
          {failure && !data?.conversationId && (
            <div role="alert" className="px-4">
              <p>{failure}</p>
              <Button size="sm" variant="ghost" onClick={context.refresh}>
                Reload Bud
              </Button>
            </div>
          )}
          <div ref={setPanelHost} className="flex min-h-0 flex-1 flex-col" />
          {position.error && (
            <div role="alert" className="shrink-0 border-t p-3 text-sm">
              <p>{position.error}</p>
              <Button size="sm" variant="ghost" onClick={() => position.move(position.corner)}>
                Save position again
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {data?.conversationId &&
        createPortal(
          <Suspense fallback={<p role="status">Opening Bud...</p>}>
            <BudChat
              key={data.conversationId}
              workspaceId={workspace.id}
              chatId={data.conversationId}
              headerElement={full ? globalHeader : null}
              visible={full || open}
              compact={!full}
            />
          </Suspense>,
          container,
        )}
    </BudContext>
  );
}
