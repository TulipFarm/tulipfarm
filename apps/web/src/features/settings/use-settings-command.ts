import { useEffect, useRef, useState } from 'react';
import { TableRequestError } from '@/features/tables/request-state';
import type { CommandRecovery } from './command-recovery';

export type CommandState<C, R> =
  | { kind: 'idle' }
  | { kind: 'sending'; command: C }
  | { kind: 'checking'; command: C }
  | { kind: 'uncertain'; command: C; checked: boolean; message: string }
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string }
  | { kind: 'saved'; receipt: R };

export function useSettingsCommand<C, R>({
  send,
  receipt,
  onSaved,
  onDenied,
  recovery,
}: {
  send: (command: C, signal: AbortSignal) => Promise<R>;
  receipt: (command: C, signal: AbortSignal) => Promise<R>;
  onSaved: (receipt: R) => void;
  onDenied: () => void;
  recovery: CommandRecovery<C>;
}) {
  const [state, setState] = useState<CommandState<C, R>>(() => {
    const command = recovery.load();
    return command
      ? {
          kind: 'uncertain',
          command,
          checked: false,
          message: 'Your unconfirmed change was restored. Check whether it was saved before retrying.',
        }
      : { kind: 'idle' };
  });
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  async function run(command: C, checking = false) {
    if (active.current) return;
    if (!checking) {
      try {
        recovery.save(command);
      } catch {
        if (state.kind !== 'uncertain')
          setState({
            kind: 'rejected',
            message:
              'Could not retain recovery information in this tab. No request was sent. Allow session storage or resolve pending changes before trying again.',
          });
        return;
      }
    }
    const recovering = checking || state.kind === 'uncertain';
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: checking ? 'checking' : 'sending', command });
    try {
      const result = await (checking ? receipt : send)(
        command,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (controller.signal.aborted) return;
      recovery.clear();
      setState({ kind: 'saved', receipt: result });
      onSaved(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      const denied = error instanceof TableRequestError && [401, 403, 404].includes(error.status);
      if (checking) {
        setState({
          kind: 'uncertain',
          command,
          checked: error instanceof TableRequestError && error.status === 404,
          message:
            error instanceof TableRequestError && error.status === 404
              ? 'No saved result is visible. This does not prove the change failed. Retry only the same request.'
              : 'Could not check whether your change was saved. Check status again when your integration or access is restored.',
        });
      } else if (recovering && denied) {
        setState({
          kind: 'uncertain',
          command,
          checked: false,
          message: 'Access changed before the original outcome could be confirmed. The original request is retained.',
        });
      } else if (error instanceof TableRequestError && error.status === 409 && error.code !== 'idempotency-conflict') {
        recovery.clear();
        setState({ kind: 'conflict' });
      } else if (
        error instanceof TableRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status) &&
        error.code !== 'idempotency-conflict'
      ) {
        recovery.clear();
        setState({
          kind: 'rejected',
          message: denied ? 'Your access changed. Refresh settings before making another change.' : error.message,
        });
      } else {
        setState({
          kind: 'uncertain',
          command,
          checked: false,
          message: 'We could not confirm your change. Check whether it was saved before retrying.',
        });
      }
      if (denied && !checking) onDenied();
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  const unresolved = state.kind === 'sending' || state.kind === 'checking' || state.kind === 'uncertain';
  return {
    state,
    unresolved,
    busy: state.kind === 'sending' || state.kind === 'checking',
    submit: (command: C) => run(command),
    check: () => {
      if (state.kind === 'uncertain') void run(state.command, true);
    },
    reset: () => {
      if (!unresolved) setState({ kind: 'idle' });
    },
  };
}
