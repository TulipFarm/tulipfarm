import { useEffect, useRef, useState } from 'react';
import { TableRequestError } from '@/features/tables/request-state';
import { browserOffline, onReconnect } from '@/lib/online';
import type { ChatEdit } from './chat-edits';
import { useChatOptimism, useConversationChanges } from './queries';
import type { Chat, ConversationApi, ConversationCommand } from './conversation-api';

export type CommandState =
  | { kind: 'idle' }
  | { kind: 'sending'; command: ConversationCommand }
  /** `offline` means the browser had no network, so the command can wait for the connection to return. */
  | { kind: 'uncertain'; command: ConversationCommand; offline: boolean }
  | { kind: 'rejected'; message: string; status: number }
  | { kind: 'accepted'; operation: ConversationCommand['kind'] };

export function useConversationCommand(api: ConversationApi, accepted: (command: ConversationCommand) => void) {
  const changes = useConversationChanges();
  const optimism = useChatOptimism();
  const [state, setState] = useState<CommandState>({ kind: 'idle' });
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** With `chat`, a rename, archive, or pin shows at once and is undone if the server does not confirm it. */
  async function submit(command: ConversationCommand, chat?: Chat) {
    if (active.current) return;
    if (browserOffline()) {
      setState({ kind: 'uncertain', command, offline: true });
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'sending', command });
    const edit = chat && chatEdit(command);
    const undo = edit ? await optimism(chat, edit) : null;
    try {
      await api.command(command, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
      await changes.command(command);
      if (mounted.current && !controller.signal.aborted) {
        setState({ kind: 'accepted', operation: command.kind });
        accepted(command);
      }
    } catch (error) {
      if (undo) {
        undo();
        void changes.command(command);
      }
      if (error instanceof TableRequestError) void changes.rejected(error.code);
      if (mounted.current && !controller.signal.aborted)
        setState(
          error instanceof TableRequestError &&
            error.status >= 400 &&
            error.status < 500 &&
            ![408, 429].includes(error.status)
            ? { kind: 'rejected', message: error.message, status: error.status }
            : { kind: 'uncertain', command, offline: browserOffline() },
        );
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  const latestSubmit = useRef(submit);
  latestSubmit.current = submit;
  const waiting = state.kind === 'uncertain' && state.offline ? state.command : null;
  useEffect(() => (waiting ? onReconnect(() => void latestSubmit.current(waiting)) : undefined), [waiting]);
  return {
    state,
    submit,
    reset: () => setState({ kind: 'idle' }),
    locked: ['sending', 'uncertain', 'rejected'].includes(state.kind),
  };
}

function chatEdit(command: ConversationCommand): ChatEdit | null {
  if (command.kind === 'rename') return { kind: 'rename', title: command.title };
  if (command.kind === 'archive') return { kind: 'archive', archived: command.archived };
  if (command.kind === 'pin') return { kind: 'pin', pinned: command.pinned };
  return null;
}
