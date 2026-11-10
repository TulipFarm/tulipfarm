import { useEffect, useRef, useState } from 'react';
import { TableRequestError } from '@/features/tables/request-state';
import { browserOffline, onReconnect } from '@/lib/online';
import { updatingRetries, updatingRetryMs, workspaceUpdating } from '@/lib/query/policy';
import type { ChatEdit } from './chat-edits';
import { useChatOptimism, useConversationChanges } from './queries';
import type { Chat, ConversationApi, ConversationCommand } from './conversation-api';

export type CommandState =
  | { kind: 'idle' }
  /** `waiting` means the workspace is taking a release's update, and the command sends by itself once it finishes. */
  | { kind: 'sending'; command: ConversationCommand; waiting?: boolean }
  | { kind: 'checking'; command: Extract<ConversationCommand, { kind: 'send' }> }
  /**
   * `offline` means the browser had no network, so the command can wait for the connection to return.
   * `updating` means the workspace was still updating when automatic retries ran out.
   */
  | { kind: 'uncertain'; command: ConversationCommand; offline: boolean; updating?: boolean }
  | { kind: 'rejected'; message: string; status: number; command?: ConversationCommand }
  | { kind: 'accepted'; operation: ConversationCommand['kind'] };

export function useConversationCommand(
  api: ConversationApi,
  accepted: (command: ConversationCommand, recoveredPages?: number) => void,
) {
  const changes = useConversationChanges();
  const optimism = useChatOptimism();
  const [state, setState] = useState<CommandState>({ kind: 'idle' });
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  async function confirm(command: ConversationCommand, controller: AbortController, recoveredPages?: number) {
    await changes.command(command);
    if (mounted.current && !controller.signal.aborted) {
      setState({ kind: 'accepted', operation: command.kind });
      accepted(command, recoveredPages);
    }
  }
  async function checkSend(command: Extract<ConversationCommand, { kind: 'send' }>, controller: AbortController) {
    if (mounted.current) setState({ kind: 'checking', command });
    const pages = await api.findMessage(
      command.chatId,
      command.messageId,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    );
    if (pages) await confirm(command, controller, pages);
    else await changes.command(command);
    return pages !== null;
  }
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
      // The command ID makes each retry safe: the server applies the command once.
      for (let attempt = 1; ; attempt++) {
        try {
          await api.command(command, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
          break;
        } catch (error) {
          if (!workspaceUpdating(error) || attempt >= updatingRetries || controller.signal.aborted) throw error;
          if (mounted.current) setState({ kind: 'sending', command, waiting: true });
          await new Promise(resolve => setTimeout(resolve, updatingRetryMs));
        }
      }
      await confirm(command, controller);
    } catch (error) {
      if (undo) {
        undo();
        void changes.command(command);
      }
      if (error instanceof TableRequestError) void changes.rejected(error.code);
      const rejected =
        error instanceof TableRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status);
      if (command.kind === 'send' && (!rejected || error.status === 409) && !browserOffline()) {
        try {
          if (await checkSend(command, controller)) return;
        } catch {
          if (mounted.current && !controller.signal.aborted)
            setState({ kind: 'uncertain', command, offline: browserOffline() });
          return;
        }
      }
      if (mounted.current && !controller.signal.aborted)
        setState(
          rejected
            ? { kind: 'rejected', message: error.message, status: error.status, command }
            : { kind: 'uncertain', command, offline: browserOffline(), updating: workspaceUpdating(error) },
        );
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  async function recover() {
    if (active.current || (state.kind !== 'uncertain' && state.kind !== 'rejected')) return;
    const command = state.command;
    if (command?.kind !== 'send') return;
    const controller = new AbortController();
    active.current = controller;
    let retry = false;
    try {
      if (await checkSend(command, controller)) return;
      if (mounted.current && !controller.signal.aborted) {
        if (state.kind === 'rejected') setState({ kind: 'idle' });
        else retry = true;
      }
    } catch {
      if (mounted.current && !controller.signal.aborted)
        setState({ kind: 'uncertain', command, offline: browserOffline() });
    } finally {
      if (active.current === controller) active.current = null;
    }
    if (retry) await submit(command);
  }
  const latestSubmit = useRef(submit);
  latestSubmit.current = submit;
  const waiting = state.kind === 'uncertain' && state.offline ? state.command : null;
  useEffect(() => (waiting ? onReconnect(() => void latestSubmit.current(waiting)) : undefined), [waiting]);
  return {
    state,
    submit,
    recover,
    reset: () => setState({ kind: 'idle' }),
    locked: ['sending', 'checking', 'uncertain', 'rejected'].includes(state.kind),
  };
}

function chatEdit(command: ConversationCommand): ChatEdit | null {
  if (command.kind === 'rename') return { kind: 'rename', title: command.title };
  if (command.kind === 'archive') return { kind: 'archive', archived: command.archived };
  if (command.kind === 'pin') return { kind: 'pin', pinned: command.pinned };
  return null;
}
