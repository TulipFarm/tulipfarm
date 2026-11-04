import { z } from 'zod';
import type { EarlyRead } from '@/lib/query/early-reads';
import { projectApi } from '@/features/projects/api';
import { projectKeys } from '@/features/projects/queries';
import { conversationApi } from './conversation-api';
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
