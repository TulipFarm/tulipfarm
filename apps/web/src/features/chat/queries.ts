import { useEffect, useMemo, useRef } from 'react';
import { freshness, useFeatureChanges, useFeatureRead, useLoadedWindow } from '@/lib/query';
import { replyBackoff } from '@/lib/query/polling';
import { useFeatureContext } from '@/lib/query/provider';
import { scopeKey } from '@/lib/query/scope';
import { creditKeys } from '@/lib/credit-keys';
import { modelKeys } from '@/features/models/queries';
import {
  hasPendingReplies,
  type ChatHistoryPage,
  type ChatListPage,
  type ConversationApi,
  type ConversationCommand,
  type ConversationHistory,
} from './conversation-api';
import { createPageReuse } from './page-reuse';
import { interactionPending, type InteractionReference } from './interaction-contracts';

export const conversationKeys = {
  lists: () => ['conversations', 'list'] as const,
  list: (archived: boolean, search: string, pages: number, projectId: string | null) =>
    ['conversations', 'list', { archived, search, pages, projectId }] as const,
  detail: (id: string) => ['conversations', 'detail', id] as const,
  histories: (id: string) => ['conversations', 'detail', id, 'history'] as const,
  history: (id: string, pages: number) => ['conversations', 'detail', id, 'history', { pages }] as const,
  interaction: (id: string, reference: InteractionReference) =>
    [
      'conversations',
      'detail',
      id,
      'interaction',
      reference.kind === 'request' ? 'request' : 'approval',
      reference.kind === 'request' ? reference.requestId : reference.approvalId,
    ] as const,
  draft: (chatId: string, id: string) => ['conversations', 'detail', chatId, 'draft', id] as const,
  attachment: (chatId: string, id: string) => ['conversations', 'detail', chatId, 'attachment', id] as const,
  maintenance: (chatId: string) => ['conversations', 'detail', chatId, 'maintenance'] as const,
  compaction: (chatId: string, id: string) => ['conversations', 'detail', chatId, 'compaction', id] as const,
  plans: (chatId: string) => ['conversations', 'detail', chatId, 'plans'] as const,
  planList: (chatId: string) => ['conversations', 'detail', chatId, 'plans', 'list'] as const,
  plan: (chatId: string, id: string) => ['conversations', 'detail', chatId, 'plans', id] as const,
};

export function useConversationChanges() {
  const { change } = useFeatureChanges();
  return useMemo(
    () => ({
      created: (chatId: string) => change({ keys: [conversationKeys.detail(chatId), conversationKeys.lists()] }),
      command: (command: ConversationCommand) =>
        change({
          keys: [
            conversationKeys.detail(command.chatId),
            conversationKeys.lists(),
            ...(['rename', 'archive', 'create', 'move'].includes(command.kind) ? [] : [creditKeys.balance()]),
          ],
        }),
      progress: () => change({ keys: [conversationKeys.lists(), creditKeys.balance()] }),
      interaction: (chatId: string) =>
        change({ keys: [conversationKeys.detail(chatId), conversationKeys.lists(), creditKeys.balance()] }),
      savedDraft: (chatId: string, kind: 'agent' | 'skill' | 'workflow' | 'workflow-activation' | 'row') =>
        change({
          keys: [
            conversationKeys.detail(chatId),
            conversationKeys.lists(),
            [kind === 'agent' ? 'agents' : kind === 'skill' ? 'skills' : kind === 'row' ? 'tables' : 'workflows'],
          ],
        }),
      rejected: (code: string) =>
        change({
          keys:
            code === 'credits-exhausted'
              ? [creditKeys.balance()]
              : code.startsWith('model-')
                ? [modelKeys.catalog()]
                : [],
        }),
    }),
    [change],
  );
}

export function useConversationList(
  api: ConversationApi,
  archived: boolean,
  search: string,
  pages: number,
  projectId: string | null = null,
) {
  const { runtime, scope } = useFeatureContext();
  const identity = JSON.stringify(scopeKey(scope));
  const reuse = useMemo(() => createPageReuse<ChatListPage>(), [runtime, identity, api, archived, search, projectId]);
  const read = useFeatureRead({
    key: conversationKeys.list(archived, search, pages, projectId),
    load: signal => api.list(signal, archived, search, pages, projectId, reuse),
  });
  return {
    ...read,
    state: useLoadedWindow(
      read.state,
      JSON.stringify([archived, search, projectId]),
      pages,
      conversationKeys.list(archived, search, pages, projectId),
    ),
  };
}

export function terminalTurns(history: ConversationHistory) {
  return history.messages.flatMap(message =>
    message.turn && ['completed', 'failed', 'blocked', 'cancelled'].includes(message.turn.status)
      ? [`${message.turn.id}:${message.turn.generation}:${message.turn.status}`]
      : [],
  );
}

/** A live event stream announces changes, so polling only backs it up; otherwise poll with a backoff that never gives up on a pending reply. */
export const historyInterval = (live: boolean) => (checks: number) => (live ? 15_000 : replyBackoff(checks));

export function useConversationHistory(api: ConversationApi, chatId: string, pages: number, live = false) {
  const { runtime, scope } = useFeatureContext();
  const identity = JSON.stringify(scopeKey(scope));
  const reuse = useMemo(() => createPageReuse<ChatHistoryPage>(), [runtime, identity, api, chatId]);
  const interval = useMemo(() => historyInterval(live), [live]);
  const read = useFeatureRead({
    key: conversationKeys.history(chatId, pages),
    load: signal => api.history(chatId, signal, pages, reuse),
    staleTime: freshness.chat,
    pollWhile: hasPendingReplies,
    interval,
    maxChecks: Infinity,
  });
  const { restart } = read;
  useEffect(() => {
    restart();
  }, [live, restart]);
  const changes = useConversationChanges();
  const observed = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (read.state.kind !== 'ready') return;
    const terminal = terminalTurns(read.state.data);
    if (!observed.current) {
      observed.current = new Set(terminal);
      return;
    }
    let changed = false;
    for (const token of terminal) {
      if (!observed.current.has(token)) {
        observed.current.add(token);
        changed = true;
      }
    }
    if (changed) void changes.progress();
  }, [read.state, changes]);
  return { ...read, state: useLoadedWindow(read.state, chatId, pages, conversationKeys.history(chatId, pages)) };
}

export function useConversationInteraction(
  api: ConversationApi,
  chatId: string,
  reference: InteractionReference,
  enabled: boolean,
) {
  return useFeatureRead({
    key: conversationKeys.interaction(chatId, reference),
    load: signal => api.interaction(chatId, reference, signal),
    pollWhile: interactionPending,
    enabled,
  });
}

export const draftPending = (draft: Awaited<ReturnType<ConversationApi['draft']>>) =>
  draft.status === 'pending' || draft.status === 'preparing';

export function useAuthoringDraft(api: ConversationApi, chatId: string, id: string, enabled = true) {
  const read = useFeatureRead({
    key: conversationKeys.draft(chatId, id),
    load: signal => api.draft(chatId, id, signal),
    pollWhile: draftPending,
    enabled,
  });
  const changes = useConversationChanges();
  const saved = useRef(false);
  useEffect(() => {
    if (read.state.kind === 'ready' && read.state.data.status === 'saved' && !saved.current) {
      saved.current = true;
      void changes.savedDraft(chatId, read.state.data.proposal.kind);
    }
  }, [read.state, changes, chatId]);
  return read;
}

export function useConversationAttachment(api: ConversationApi, chatId: string, id: string) {
  return useFeatureRead({
    key: conversationKeys.attachment(chatId, id),
    load: signal => api.attachment(chatId, id, signal),
  });
}
