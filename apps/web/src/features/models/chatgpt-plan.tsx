import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Input } from '@tulipfarm/sprout/input';
import { useFeatureChanges } from '@/lib/query';
import { chatGptUsageUrl } from '@/features/chat/reply-failure-copy';
import { TableRequestError } from '@/features/tables/request-state';
import {
  chatGptErrorMessage,
  chatGptPlanApi,
  type ChatGptAttempt,
  type ChatGptConnectionMode,
} from './chatgpt-plan-api';
import { modelKeys } from './queries';
import { chatGptConnectionKey, useChatGptConnection } from './plan-connections';
import { useOwnPlans, type PlanAccount, type PlanConnector } from './plan-accounts';
import { expectNewPlan, subscriptionsKey } from './subscription-sharing';

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
 * Sign in with ChatGPT for the member's own accounts, up to five. One click opens ChatGPT in a new tab; the panel then
 * waits for the sign-in and offers a field for the address the tab ends on. `outcome` is the result flag the loopback
 * sign-in page sends back to the Models page.
 */
export function useChatGptPlan(
  workspaceId: string,
  outcome?: string | undefined,
  clearOutcome?: () => void,
): PlanConnector {
  const api = useMemo(() => chatGptPlanApi(workspaceId), [workspaceId]);
  const read = useChatGptConnection(workspaceId);
  const owns = useOwnPlans(workspaceId, 'chatgpt');
  const { change } = useFeatureChanges();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [message, setMessage] = useState<{ tone: 'error' | 'success' | 'warning'; text: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const [welcomeSaving, setWelcomeSaving] = useState(false);
  const refreshAll = useCallback(
    () => change({ keys: [chatGptConnectionKey, subscriptionsKey, modelKeys.catalog()] }),
    [change],
  );

  useEffect(() => {
    if (!outcome) return;
    setMessage(
      outcome === 'connected'
        ? { tone: 'success', text: 'ChatGPT is connected.' }
        : { tone: 'error', text: chatGptErrorMessage(outcome) },
    );
    void refreshAll();
    clearOutcome?.();
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

  /** Without `connectionId`, adds an account; with it, renews that account's sign-in. */
  async function begin(mode: ChatGptConnectionMode, connectionId?: string) {
    if (!connectionId) expectNewPlan(workspaceId, 'chatgpt', owns);
    setMessage(null);
    setPasted('');
    // Open the tab during the click so the browser does not block it, then point it at ChatGPT.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setPhase({ kind: 'starting' });
    try {
      const attempt = await api.begin(mode, connectionId, freshSignal());
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

  async function disconnect(account: PlanAccount) {
    setPhase({ kind: 'disconnecting' });
    setMessage(null);
    try {
      const { revoked } = await api.disconnect(account.connectionId, freshSignal());
      const who = account.account ?? 'your ChatGPT account';
      setMessage(
        revoked
          ? { tone: 'success', text: `${account.account ?? 'ChatGPT'} is disconnected.` }
          : {
              tone: 'warning',
              text: `TulipFarm removed the sign-in for ${who}, but ChatGPT didn’t confirm the disconnect. To be sure, remove TulipFarm in your ChatGPT settings.`,
            },
      );
      void refreshAll();
    } catch (error) {
      setMessage({ tone: 'error', text: failure(error) });
    } finally {
      setPhase({ kind: 'idle' });
    }
  }

  async function acknowledge(connectionId: string) {
    setWelcomeSaving(true);
    try {
      await api.acknowledgeWelcome(connectionId, freshSignal());
      await refreshAll();
    } catch (error) {
      setMessage({ tone: 'error', text: failure(error) });
    } finally {
      setWelcomeSaving(false);
    }
  }

  const { state } = read;
  const connections = state.kind === 'ready' && state.data ? state.data.connections : [];
  const accounts = connections.flatMap((connection): PlanAccount[] =>
    connection.state === 'connected' ||
    connection.state === 'plan-disabled' ||
    connection.state === 'reconnect-required'
      ? [
          {
            connectionId: connection.connectionId,
            state: connection.state,
            account: connection.email,
            ...(connection.state === 'plan-disabled'
              ? {
                  note: 'You signed in without allowing plan usage, so TulipFarm can’t use this plan yet.',
                  reconnectLabel: 'Allow plan usage',
                }
              : connection.state === 'reconnect-required'
                ? { note: 'ChatGPT ended this sign-in. Reconnect to keep using this plan in TulipFarm.' }
                : {}),
          },
        ]
      : [],
  );
  const welcome = connections.find(connection => connection.planUsage && connection.welcomePending);
  const signingIn = phase.kind === 'pending' || phase.kind === 'finishing';
  return {
    provider: 'chatgpt',
    offered: !(state.kind === 'unavailable' || (state.kind === 'ready' && state.data === null)),
    read:
      state.kind === 'loading'
        ? { kind: 'loading' }
        : state.kind === 'error'
          ? { kind: 'error', message: state.message, retry: () => void read.refresh() }
          : { kind: 'ready', stale: state.kind === 'ready' && !!state.error },
    accounts,
    message,
    busy: phase.kind === 'starting' || phase.kind === 'finishing' || phase.kind === 'disconnecting',
    signingIn,
    start: () => void begin('connect'),
    startLabel: phase.kind === 'starting' ? 'Opening ChatGPT…' : 'Connect ChatGPT',
    before: 'ChatGPT opens in a new tab. Approve TulipFarm there, and you’re done.',
    flow: signingIn && (
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
    ),
    reconnect: account =>
      void begin(account.state === 'plan-disabled' ? 'enable-plan' : 'reconnect', account.connectionId),
    disconnect,
    disconnectDescription: () =>
      'TulipFarm will stop using this ChatGPT plan, and people you shared it with will lose its models.',
    usageUrl: chatGptUsageUrl,
    overlay: welcome && (
      <Dialog open>
        <DialogContent size="form" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>You’re now using your ChatGPT plan</DialogTitle>
            <DialogDescription>
              When you pick a ChatGPT plan model in a chat or agent, requests use your ChatGPT usage, not workspace
              credits. You can see your usage in ChatGPT settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => void acknowledge(welcome.connectionId)} disabled={welcomeSaving}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  };
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
        Approve TulipFarm in the ChatGPT tab. If that tab ends on a page that can’t be reached, copy its full address
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
