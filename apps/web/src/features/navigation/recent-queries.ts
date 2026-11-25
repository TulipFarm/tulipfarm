import { useMemo } from 'react';
import { z } from 'zod';
import { fileSuggestionsPageSchema } from '@tulipfarm/files/contracts';
import { chatListReads, conversationRequest } from '@/features/chat/chat-list-api';
import { conversationKeys } from '@/features/chat/queries';
import { projectApi } from '@/features/projects/api';
import { projectKeys } from '@/features/projects/queries';
import { TableRequestError, type ReadState } from '@/features/tables/request-state';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';

export type RecentSection = 'chat' | 'projects' | 'agents' | 'agent-tasks' | 'workflows' | 'tables' | 'files';
/** `pinned` chats lead the chat section, ahead of its fifteen most recent chats. */
export type RecentItem = { id: string; name: string; pinned?: boolean };
const recentSchema = z.array(z.object({ id: z.uuid(), name: z.string() })).max(3);
/** What a section's sidebar read keeps on disk, so a reload lists it before the network answers. */
export const recentItemsSchema = z.array(z.strictObject({ id: z.string(), name: z.string() })).max(3);
/** Sections read through their own sidebar endpoint; chats and projects reuse their page's list reads. */
export const ownRecentSections = ['agents', 'agent-tasks', 'workflows', 'tables', 'files'] as const;
type OwnRecentSection = (typeof ownRecentSections)[number];
const domains: Record<RecentSection, string> = {
  chat: 'conversations',
  projects: 'projects',
  agents: 'agents',
  'agent-tasks': 'tasks',
  workflows: 'workflows',
  tables: 'tables',
  files: 'files',
};
export const recentKey = (section: OwnRecentSection) =>
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
  section: OwnRecentSection,
  signal: AbortSignal,
): Promise<RecentItem[]> {
  const bounded = requestSignal(signal);
  if (section === 'tables') {
    const { tableApi } = await import('@/features/tables/api');
    return (
      await tableApi(workspaceId).list(undefined, bounded, undefined, false, { by: 'changed', direction: 'desc' }, true)
    ).tables
      .slice(0, 3)
      .map(table => ({ id: table.id, name: table.definition.label }));
  }
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

/**
 * Chat and project recents read the same first page the Chats and Projects pages show, so the sidebar
 * shares their request and their copy on disk instead of asking again under its own key.
 */
export function useRecentItems(workspaceId: string, section: RecentSection, enabled: boolean) {
  const own = (ownRecentSections as readonly string[]).includes(section) ? (section as OwnRecentSection) : null;
  const chats = useMemo(
    () =>
      chatListReads(
        conversationRequest(workspaceId, status => {
          throw new TableRequestError(status, 'recent-chats-unavailable', 'Recent chats are unavailable.');
        }),
      ),
    [workspaceId],
  );
  const projects = useMemo(() => projectApi(workspaceId), [workspaceId]);
  const chatList = useFeatureRead({
    key: conversationKeys.list(false, '', 1, null),
    load: signal => chats.list(signal, false, '', 1),
    enabled: enabled && section === 'chat',
  });
  const pinned = useFeatureRead({
    key: conversationKeys.pinned(),
    load: signal => chats.pinned(signal),
    enabled: enabled && section === 'chat',
  });
  const projectList = useFeatureRead({
    key: projectKeys.list(),
    load: signal => projects.list(signal),
    enabled: enabled && section === 'projects',
  });
  const ownRead = useFeatureRead({
    key: recentKey(own ?? 'agents'),
    load: signal => loadRecentItems(workspaceId, own ?? 'agents', signal),
    enabled: enabled && own !== null,
  });
  const state = useMemo((): ReadState<RecentItem[]> => {
    if (own) return ownRead.state;
    if (section === 'projects')
      return mapState(projectList.state, list =>
        list
          .filter(project => !project.archived)
          .slice(0, 3)
          .map(project => ({ id: project.id, name: project.name })),
      );
    return mapState(combine(pinned.state, chatList.state), ([pins, recent]) => [
      ...pins.map(chat => ({ id: chat.id, name: chat.title || 'New chat', pinned: true })),
      ...recent.chats
        .filter(chat => !pins.some(item => item.id === chat.id))
        .slice(0, 15)
        .map(chat => ({ id: chat.id, name: chat.title || 'New chat' })),
    ]);
  }, [own, section, ownRead.state, projectList.state, pinned.state, chatList.state]);
  const refresh = own
    ? ownRead.refresh
    : section === 'projects'
      ? projectList.refresh
      : async () => {
          await Promise.all([pinned.refresh(), chatList.refresh()]);
        };
  return { state, refresh };
}

function mapState<T, U>(state: ReadState<T>, map: (data: T) => U): ReadState<U> {
  return state.kind === 'ready' ? { ...state, data: map(state.data) } : state;
}

function combine<A, B>(a: ReadState<A>, b: ReadState<B>): ReadState<[A, B]> {
  if (a.kind !== 'ready') return a;
  if (b.kind !== 'ready') return b;
  return {
    kind: 'ready',
    data: [a.data, b.data],
    refreshing: a.refreshing || b.refreshing,
    error: a.error ?? b.error,
  };
}
