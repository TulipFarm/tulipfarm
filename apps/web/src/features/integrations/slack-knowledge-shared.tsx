import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureChanges } from '@/lib/query';
import type { ReadState } from '@/features/tables/request-state';

export function ReadResult<T>({
  state,
  retry,
  label,
  children,
}: {
  state: ReadState<T>;
  retry: () => Promise<void>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (state.kind === 'loading')
    return (
      <section role="status" aria-label={`Loading ${label}`} className="space-y-3">
        <span>Loading {label}…</span>
        <Skeleton />
        <Skeleton />
      </section>
    );
  if (state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title={`${label} unavailable`}
        description="This content is missing or your access changed. Check access again or close this view."
      >
        <Button variant="outline" onClick={() => void retry()}>
          Check access again
        </Button>
      </StatePanel>
    );
  if (state.kind === 'error' || state.error)
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title={`Could not load ${label}`}
        description="Content is hidden until it can be checked again."
      >
        <Button
          variant="outline"
          disabled={state.kind === 'ready' && state.refreshing}
          aria-busy={state.kind === 'ready' && state.refreshing}
          onClick={() => void retry()}
        >
          Retry loading {label}
        </Button>
      </StatePanel>
    );
  return children(state.data);
}

export function CommandFeedback({
  state,
  retry,
}: {
  state: { kind: string; message?: string };
  retry: () => Promise<void>;
}) {
  if (state.kind === 'uncertain')
    return (
      <div className="space-y-3">
        <Alert variant="destructive">
          <AlertDescription>
            We could not confirm the outcome. Your input is kept and locked. Retry sends the same operation, not a new
            copy.
          </AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => void retry()}>
          Retry same operation
        </Button>
      </div>
    );
  if (state.kind === 'rejected')
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  if (state.kind === 'denied')
    return (
      <Alert variant="destructive">
        <AlertDescription>Your access changed. Close this view and check your workspace access.</AlertDescription>
      </Alert>
    );
  return null;
}

// Slack and GitHub source APIs both throw errors carrying the HTTP status and server error code.
export const requestStatus = (error: unknown) =>
  error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : null;

type CommandState<T> =
  | { kind: 'idle' }
  | { kind: 'sending'; input: T }
  | { kind: 'uncertain'; input: T }
  | { kind: 'rejected'; message: string }
  | { kind: 'denied' };

// One command ID per user intent: retries resend the same input so the server can replay rather than duplicate.
export function useCommand<T, R>(
  execute: (input: T, signal: AbortSignal) => Promise<R>,
  accepted: (result: R) => void | Promise<void>,
  concealKeys: readonly (readonly unknown[])[],
) {
  const [state, setState] = useState<CommandState<T>>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const { change } = useFeatureChanges();
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  async function send(input: T) {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setState({ kind: 'sending', input });
    try {
      const result = await execute(input, current.signal);
      if (current.signal.aborted) return;
      setState({ kind: 'idle' });
      await accepted(result);
    } catch (error) {
      if (current.signal.aborted) return;
      const status = requestStatus(error);
      if (status !== null && [401, 403, 404].includes(status)) {
        setState({ kind: 'denied' });
        await change({ kind: 'conceal', keys: concealKeys });
      } else if (error instanceof Error && status !== null && status < 500 && ![408, 429].includes(status)) {
        setState({ kind: 'rejected', message: error.message });
      } else setState({ kind: 'uncertain', input });
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  return {
    state,
    send,
    locked: state.kind === 'sending' || state.kind === 'uncertain',
    retry: () => (state.kind === 'uncertain' ? send(state.input) : Promise.resolve()),
  };
}

export function useExpired(validUntil: string | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!validUntil) return;
    const update = () => tick(value => value + 1);
    const timer = window.setTimeout(
      update,
      Math.max(0, Math.min(Date.parse(validUntil) - Date.now() + 1, 2_147_483_647)),
    );
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [validUntil]);
  return !!validUntil && Date.parse(validUntil) <= Date.now();
}
