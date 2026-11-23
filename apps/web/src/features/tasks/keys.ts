import { conversationKeys } from '@/features/chat/queries';

export const taskKeys = {
  all: ['tasks'] as const,
  lists: ['tasks', 'list'] as const,
  list: (after?: string, search = '') => ['tasks', 'list', { after: after ?? null, search }] as const,
  detail: (id: string) => ['tasks', 'detail', id] as const,
  summary: (id: string) => ['tasks', 'detail', id, 'summary'] as const,
  context: (id: string) => ['tasks', 'detail', id, 'context'] as const,
  history: (id: string, after = -1) => ['tasks', 'detail', id, 'history', { after }] as const,
  proposals: (id: string) => ['tasks', 'detail', id, 'proposals'] as const,
  proposalPage: (id: string, after?: string) =>
    ['tasks', 'detail', id, 'proposals', 'list', { after: after ?? null }] as const,
  proposal: (id: string, proposalId: string) => ['tasks', 'detail', id, 'proposals', 'detail', proposalId] as const,
  slack: (id: string) => ['tasks', 'detail', id, 'slack-actions'] as const,
  sources: ['tasks', 'sources'] as const,
  sourceTasks: (after?: string, exclude?: string) =>
    ['tasks', 'sources', 'tasks', { after: after ?? null, exclude: exclude ?? null }] as const,
  sourceChats: conversationKeys.list(false, '', 1, null),
  sourceFiles: (chatId: string) => [...conversationKeys.detail(chatId), 'source-files', { pages: 1 }] as const,
  attachment: conversationKeys.attachment,
};
