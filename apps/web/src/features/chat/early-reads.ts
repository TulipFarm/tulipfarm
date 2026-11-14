import { z } from 'zod';
import type { QueryKey } from '@tanstack/react-query';
import type { EarlyRead } from '@/lib/query/early-reads';
import type { PersistedRead } from '@/lib/query/persisted-reads';
import { chatGptConnectionSchema } from '@/features/models/chatgpt-plan-api';
import { tokenConnectionSchema } from '@/features/models/token-plan-api';
import { projectApi, projectListSchema } from '@/features/projects/api';
import { projectKeys } from '@/features/projects/queries';
import { integrationDirectoryPersistedReads, integrationDirectoryReads } from '@/features/integrations/directory-reads';
import { chatHistorySchema, chatListSchema, conversationApi } from './conversation-api';
import { conversationKeys } from './queries';

const chatId = z.uuid();
const projectId = z.uuid();

/**
 * The first reads a workspace page makes, keyed and loaded exactly as its queries do, so the
 * router can start them during workspace admission. Search, archive and paging all start at
 * their defaults on a fresh page.
 */
export function workspacePageReads(
  workspaceId: string,
  slug: string,
  pathname: string,
  search: Record<string, unknown>,
): EarlyRead[] {
  const [first, page, id, ...rest] = pathname.replace(/\/+$/, '').split('/').slice(1);
  if (first !== slug) return [];
  const conversations = conversationApi(workspaceId, () => {});
  const projects = { key: projectKeys.list(), load: projectApi(workspaceId).list };
  if (page === undefined || page === 'projects') return id === undefined ? [projects] : [];
  if (page === 'integrations') return id === undefined ? integrationDirectoryReads(workspaceId) : [];
  if (page !== 'chat' || rest.length) return [];
  if (id === undefined) {
    const project = projectId.safeParse(search.project);
    const scope = project.success ? project.data : null;
    return [
      projects,
      {
        key: conversationKeys.list(false, '', 1, scope),
        load: signal => conversations.list(signal, false, '', 1, scope),
      },
    ];
  }
  if (!chatId.safeParse(id).success) return [];
  return [projects, { key: conversationKeys.history(id, 1), load: signal => conversations.history(id, signal, 1) }];
}

const listKey = z.tuple([
  z.literal('conversations'),
  z.literal('list'),
  z.strictObject({
    archived: z.literal(false),
    search: z.literal(''),
    pages: z.literal(1),
    projectId: projectId.nullable(),
  }),
]);
const historyKey = z.tuple([
  z.literal('conversations'),
  z.literal('detail'),
  chatId,
  z.literal('history'),
  z.strictObject({ pages: z.literal(1) }),
]);
const projectsKey = z.tuple([z.literal('projects'), z.literal('list')]);
// The Models page rail reads each plan connection; keeping the last answer lets a reload show it at once.
const chatGptKey = z.tuple([z.literal('models'), z.literal('chatgpt-connection')]);
const tokenPlanKey = z.tuple([z.literal('models'), z.enum(['claude-connection', 'copilot-connection'])]);
const matches = (schema: z.ZodType) => (key: QueryKey) => schema.safeParse(key).success;

/** The first pages of these reads persist, so a return visit shows them before the network answers. */
export const persistedPageReads: PersistedRead[] = [
  { name: 'chat-list', limit: 4, match: matches(listKey), schema: chatListSchema },
  { name: 'chat-history', limit: 12, match: matches(historyKey), schema: chatHistorySchema },
  { name: 'projects', limit: 1, match: matches(projectsKey), schema: projectListSchema },
  { name: 'chatgpt-connection', limit: 1, match: matches(chatGptKey), schema: chatGptConnectionSchema.nullable() },
  { name: 'token-plan-connection', limit: 2, match: matches(tokenPlanKey), schema: tokenConnectionSchema.nullable() },
  ...integrationDirectoryPersistedReads,
];
