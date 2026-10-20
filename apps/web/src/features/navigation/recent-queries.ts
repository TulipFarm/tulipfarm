import { z } from 'zod';
import { fileSuggestionsPageSchema } from '@tulipfarm/files/contracts';
import { conversationApi } from '@/features/chat/conversation-api';
import { projectApi } from '@/features/projects/api';
import { tableApi } from '@/features/tables/api';
import { TableRequestError } from '@/features/tables/request-state';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';

export type RecentSection = 'chat' | 'projects' | 'agents' | 'agent-tasks' | 'workflows' | 'tables' | 'files';
export type RecentItem = { id: string; name: string };
const recentSchema = z.array(z.object({ id: z.uuid(), name: z.string() })).max(3);
const domains: Record<RecentSection, string> = {
  chat: 'conversations',
  projects: 'projects',
  agents: 'agents',
  'agent-tasks': 'tasks',
  workflows: 'workflows',
  tables: 'tables',
  files: 'files',
};
export const recentKey = (section: RecentSection) =>
  [domains[section], section === 'files' ? 'library' : 'list', 'sidebar'] as const;

async function recentRequest(workspaceId: string, section: RecentSection, signal: AbortSignal, after?: string) {
  const response = await jsonResponse(
    `${apiOrigin}/v1/workspaces/${workspaceId}/${section}/recent${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    { signal, cache: 'no-store' },
  );
  if (!response.ok)
    throw new TableRequestError(response.status, 'recent-items-unavailable', 'Recent items could not be loaded.');
  return readJson(response);
}

export async function loadRecentItems(
  workspaceId: string,
  section: RecentSection,
  signal: AbortSignal,
): Promise<RecentItem[]> {
  const bounded = requestSignal(signal);
  if (section === 'chat')
    return (
      await conversationApi(workspaceId, status => {
        throw new TableRequestError(status, 'recent-chats-unavailable', 'Recent chats are unavailable.');
      }).list(bounded, false, '', 1)
    ).chats
      .slice(0, 3)
      .map(chat => ({ id: chat.id, name: chat.title || 'New chat' }));
  if (section === 'projects')
    return (await projectApi(workspaceId).list(bounded))
      .filter(project => !project.archived)
      .slice(0, 3)
      .map(project => ({ id: project.id, name: project.name }));
  if (section === 'tables')
    return (
      await tableApi(workspaceId).list(undefined, bounded, undefined, false, { by: 'changed', direction: 'desc' })
    ).tables
      .slice(0, 3)
      .map(table => ({ id: table.id, name: table.definition.label }));
  if (section !== 'files') return recentSchema.parse(await recentRequest(workspaceId, section, bounded));
  const items = new Map<string, RecentItem>();
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = fileSuggestionsPageSchema.parse(await recentRequest(workspaceId, section, bounded, after));
    for (const item of result.items) items.set(item.id, { id: item.id, name: item.name });
    if (items.size >= 3 || !result.next) return [...items.values()].slice(0, 3);
    if (result.next === after) throw new Error('Recent files cursor did not advance.');
    after = result.next;
  }
  throw new Error('Recent files exceeded the supported read window.');
}

export function useRecentItems(workspaceId: string, section: RecentSection, enabled: boolean) {
  return useFeatureRead({
    key: recentKey(section),
    load: signal => loadRecentItems(workspaceId, section, signal),
    enabled,
  });
}
