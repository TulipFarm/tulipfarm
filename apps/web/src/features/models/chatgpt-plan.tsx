import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { chatGptUsageUrl } from '@/features/chat/reply-failure-copy';
import { TableRequestError } from '@/features/tables/request-state';
import {
  chatGptErrorMessage,
  chatGptPlanApi,
  type ChatGptAttempt,
  type ChatGptConnection,
  type ChatGptConnectionMode,
} from './chatgpt-plan-api';
import { modelKeys } from './queries';

const connectionKey = ['models', 'chatgpt-connection'] as const;
const pollMs = 2000;

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'pending'; attempt: ChatGptAttempt; opened: boolean; deadline: number }
  | { kind: 'finishing'; attempt: ChatGptAttempt; opened: boolean; deadline: number }
  | { kind: 'disconnecting' };

function failure(error: unknown) {
  if (error instanceof TableRequestError) return error.message;
  return chatGptErrorMessage('unavailable');
}

/**
 * The member's own "Sign in with ChatGPT" connection. It is personal: each member connects their own plan,
 * and only their own chats use it. `outcome` is the result flag the loopback sign-in page sends back.
 */
export function ChatGptPlanSection({
  workspaceId,
  outcome,
  clearOutcome,
}: {
  workspaceId: string;
  outcome: string | undefined;
  clearOutcome: () => void;
}) {
  const api = useMemo(() => chatGptPlanApi(workspaceId), [workspaceId]);
  const read = useFeatureRead({ key: connectionKey, load: api.connection });
  const { change } = useFeatureChanges();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [message, setMessage] = useState<{ tone: 'error' | 'success' | 'warning'; text: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const [welcomeSaving, setWelcomeSaving] = useState(false);
  const refreshAll = useCallback(() => change({ keys: [connectionKey, modelKeys.catalog()] }), [change]);

  useEffect(() => {
    if (!outcome) return;
    setMessage(
      outcome === 'connected'
        ? { tone: 'success', text: 'ChatGPT is connected.' }
        : { tone: 'error', text: chatGptErrorMessage(outcome) },
    );
    void refreshAll();
    clearOutcome();
  }, [outcome, clearOutcome, refreshAll]);

  const pendingAttempt = phase.kind === 'pending' ? phase.attempt.attemptId : null;
  const deadline = phase.kind === 'pending' ? phase.deadline : 0;
  useEffect(() => {
    if (!pendingAttempt) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        setPhase({ kind: 'idle' });
        setMessage({ tone: 'error', text: chatGptErrorMessage('attempt-expired') });
        return;
      }
      void api.attempt(pendingAttempt, controller.signal).then(
        result => {
          if (controller.signal.aborted || result.status === 'pending') return;
          setPhase({ kind: 'idle' });
          setPasted('');
          setMessage(
            result.status === 'completed'
              ? { tone: 'success', text: 'ChatGPT is connected.' }
              : { tone: 'error', text: chatGptErrorMessage(result.errorCode) },
          );
          void refreshAll();
        },
        // A missed check is retried on the next tick; the paste field stays available.
        () => undefined,
      );
    }, pollMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, pendingAttempt, deadline, refreshAll]);

  const signal = useRef<AbortController | null>(null);
  useEffect(() => () => signal.current?.abort(), []);
  function freshSignal() {
    signal.current?.abort();
    signal.current = new AbortController();
    return AbortSignal.any([signal.current.signal, AbortSignal.timeout(30_000)]);
  }

  async function begin(mode: ChatGptConnectionMode) {
    setMessage(null);
    setPasted('');
    // Open the tab during the click so the browser does not block it, then point it at ChatGPT.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setPhase({ kind: 'starting' });
    try {
      const attempt = await api.begin(mode, freshSignal());
      if (tab && !tab.closed) tab.location.href = attempt.authorizeUrl;
      setPhase({
        kind: 'pending',
        attempt,
        opened: !!tab,
        deadline: Date.now() + attempt.expiresInSeconds * 1000,
      });
    } catch (error) {
      tab?.close();
      setPhase({ kind: 'idle' });
      setMessage({ tone: 'error', text: failure(error) });
    }
  }

  async function finish() {
    if (phase.kind !== 'pending') return;
    const address = pasted.trim();
    if (!address) {
      setMessage({ tone: 'error', text: chatGptErrorMessage('callback-invalid') });
      return;
    }
    setPhase({ ...phase, kind: 'finishing' });
    setMessage(null);
    try {
      await api.complete(address, freshSignal());
      setPhase({ kind: 'idle' });
      setPasted('');
      setMessage({ tone: 'success', text: 'ChatGPT is connected.' });
      void refreshAll();
    } catch (error) {
      const code = error instanceof TableRequestError ? error.code : 'unavailable';
      // A wrong paste keeps the sign-in open; anything else ends it.
      setPhase(
        code === 'callback-invalid' || code === 'unavailable' ? { ...phase, kind: 'pending' } : { kind: 'idle' },
      );
      setMessage({ tone: 'error', text: failure(error) });
    }
  }

  async function disconnect() {
    setPhase({ kind: 'disconnecting' });
    setMessage(null);
    try {
      const { revoked } = await api.disconnect(freshSignal());
      setMessage(
        revoked
          ? { tone: 'success', text: 'ChatGPT is disconnected.' }
          : {
              tone: 'warning',
              text: 'TulipFarm forgot your ChatGPT sign-in, but ChatGPT did not confirm the disconnect. To be sure, disconnect TulipFarm in your ChatGPT settings.',
            },
      );
      void refreshAll();
    } catch (error) {
      setMessage({ tone: 'error', text: failure(error) });
    } finally {
      setPhase({ kind: 'idle' });
    }
  }

  async function acknowledge() {
    setWelcomeSaving(true);
    try {
      await api.acknowledgeWelcome(freshSignal());
      await refreshAll();
    } catch (error) {
      setMessage({ tone: 'error', text: failure(error) });
    } finally {
      setWelcomeSaving(false);
    }
  }

  const { state } = read;
  // The deployment turned ChatGPT plan usage off, or this member has no access: show nothing.
  if (state.kind === 'unavailable' || (state.kind === 'ready' && state.data === null)) return null;
  const connection = state.kind === 'ready' ? state.data : null;
  const busy = phase.kind !== 'idle' && phase.kind !== 'pending';

  return (
    <FormSection
      title="Use your ChatGPT plan"
      description="Complete eligible AI requests in TulipFarm with usage included in your ChatGPT plan or credits balance."
      meta="Only you"
    >
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          This is separate from TulipFarm credits. Requests you make with a ChatGPT plan model use your ChatGPT usage
          and are not charged to this workspace.
        </p>
        {state.kind === 'loading' && (
          <div role="status" aria-label="Checking your ChatGPT connection" className="grid gap-2">
            <Skeleton />
            <Skeleton shape="action" />
          </div>
        )}
        {state.kind === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>Couldn’t check your ChatGPT connection. {state.message}</AlertDescription>
            <Button size="sm" variant="outline" onClick={() => void read.refresh()}>
              Retry
            </Button>
          </Alert>
        )}
        {state.kind === 'ready' && state.error && (
          <p role="status" className="text-sm text-muted-foreground">
            This status may be out of date. Reload to check again.
          </p>
        )}
        {message && (
          <Alert variant={message.tone === 'error' ? 'destructive' : 'default'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        {connection && (phase.kind === 'pending' || phase.kind === 'finishing') && (
          <PendingSignIn
            phase={phase}
            pasted={pasted}
            setPasted={setPasted}
            finish={() => void finish()}
            cancel={() => {
              setPhase({ kind: 'idle' });
              setPasted('');
            }}
          />
        )}
        {connection && phase.kind !== 'pending' && phase.kind !== 'finishing' && (
          <ConnectionState
            connection={connection}
            busy={busy}
            begin={mode => void begin(mode)}
            disconnect={() => void disconnect()}
          />
        )}
      </div>
      {connection?.planUsage && connection.welcomePending && (
        <Dialog open>
          <DialogContent size="form" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>You're using your ChatGPT plan</DialogTitle>
              <DialogDescription>
                Eligible AI requests you make in TulipFarm will use your ChatGPT plan. You can manage usage in ChatGPT
                settings.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => void acknowledge()} disabled={welcomeSaving}>
                Got it
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </FormSection>
  );
}

function ManageUsageLink({ variant = 'outline' }: { variant?: 'outline' | 'default' }) {
  return (
    <Button
      size="sm"
      variant={variant}
      nativeButton={false}
      render={<a href={chatGptUsageUrl} target="_blank" rel="noopener noreferrer" />}
    >
      Manage usage
      <ArrowUpRight size={14} aria-hidden="true" />
    </Button>
  );
}

function ConnectionState({
  connection,
  busy,
  begin,
  disconnect,
}: {
  connection: ChatGptConnection;
  busy: boolean;
  begin: (mode: ChatGptConnectionMode) => void;
  disconnect: () => void;
}) {
  const account = connection.email ? (
    <p className="text-sm">
      Signed in as <span className="font-medium">{connection.email}</span>
    </p>
  ) : null;
  if (connection.state === 'connected')
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {account}
          <Badge variant="success">Using ChatGPT plan</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {connection.models.length
            ? `Your chats can use ${connection.models.map(model => model.label).join(', ')}. Pick one in the chat model menu, under ChatGPT plan.`
            : 'ChatGPT lists no models TulipFarm can offer for your plan right now.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <ManageUsageLink />
          <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
      </div>
    );
  if (connection.state === 'plan-disabled')
    return (
      <div className="grid gap-3">
        {account}
        <p className="text-sm text-muted-foreground">
          You signed in without allowing plan usage, so TulipFarm can't use your ChatGPT plan yet.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => begin('enable-plan')} disabled={busy}>
            Enable ChatGPT plan usage
          </Button>
          <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        </div>
      </div>
    );
  if (connection.state === 'reconnect-required')
    return (
      <div className="grid gap-3">
        <Alert>
          <AlertTitle>Reconnect ChatGPT</AlertTitle>
          <AlertDescription>
            ChatGPT ended this sign-in{connection.email ? ` for ${connection.email}` : ''}. Reconnect to keep using your
            plan in TulipFarm.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => begin('reconnect')} disabled={busy}>
            Reconnect
          </Button>
          <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => begin('connect')} disabled={busy}>
        <BrandIcon brand="openai" size="inline" />
        Continue with ChatGPT
      </Button>
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          Starting sign-in…
        </p>
      )}
    </div>
  );
}

function PendingSignIn({
  phase,
  pasted,
  setPasted,
  finish,
  cancel,
}: {
  phase: Extract<Phase, { kind: 'pending' | 'finishing' }>;
  pasted: string;
  setPasted: (value: string) => void;
  finish: () => void;
  cancel: () => void;
}) {
  const finishing = phase.kind === 'finishing';
  return (
    <div className="grid gap-3">
      <p role="status" className="text-sm">
        Approve TulipFarm in the ChatGPT tab. If that tab ends on a page that can't be reached, copy its full address
        and paste it here.
      </p>
      {!phase.opened && (
        <p className="text-sm text-muted-foreground">
          Your browser blocked the new tab.{' '}
          <a
            className="underline underline-offset-2"
            href={phase.attempt.authorizeUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open ChatGPT sign-in
          </a>
        </p>
      )}
      <form
        className="grid gap-2"
        onSubmit={event => {
          event.preventDefault();
          finish();
        }}
      >
        <Field
          id="chatgpt-callback"
          required
          label="Address from the ChatGPT tab"
          helper={`It starts with ${phase.attempt.redirectUri}`}
        >
          <Input
            value={pasted}
            onChange={event => setPasted(event.target.value)}
            placeholder={`${phase.attempt.redirectUri}?code=…`}
            autoComplete="off"
            spellCheck={false}
            readOnly={finishing}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={finishing}>
            {finishing ? 'Finishing…' : 'Finish connecting'}
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={cancel} disabled={finishing}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
