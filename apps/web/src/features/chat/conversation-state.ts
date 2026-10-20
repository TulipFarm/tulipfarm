import { useEffect, useRef, useState } from 'react';
import { TableRequestError } from '@/features/tables/request-state';
import { useConversationChanges } from './queries';
import type { ConversationApi, ConversationCommand } from './conversation-api';

type CommandState =
  | { kind: 'idle' }
  | { kind: 'sending'; command: ConversationCommand }
  | { kind: 'uncertain'; command: ConversationCommand }
  | { kind: 'rejected'; message: string; status: number }
  | { kind: 'accepted'; operation: ConversationCommand['kind'] };

export function useConversationCommand(api: ConversationApi, accepted: (command: ConversationCommand) => void) {
  const changes = useConversationChanges();
  const [state, setState] = useState<CommandState>({ kind: 'idle' });
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit(command: ConversationCommand) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'sending', command });
    try {
      await api.command(command, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
      await changes.command(command);
      if (mounted.current && !controller.signal.aborted) {
        setState({ kind: 'accepted', operation: command.kind });
        accepted(command);
      }
    } catch (error) {
      if (error instanceof TableRequestError) void changes.rejected(error.code);
      if (mounted.current && !controller.signal.aborted)
        setState(
          error instanceof TableRequestError &&
            error.status >= 400 &&
            error.status < 500 &&
            ![408, 429].includes(error.status)
            ? { kind: 'rejected', message: error.message, status: error.status }
            : { kind: 'uncertain', command },
        );
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  return {
    state,
    submit,
    reset: () => setState({ kind: 'idle' }),
    locked: ['sending', 'uncertain', 'rejected'].includes(state.kind),
  };
}
