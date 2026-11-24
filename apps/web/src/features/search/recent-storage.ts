import { z } from 'zod';
import type { WorkspacePath } from '../../pages/workspace.tsx';

export type SearchPath = WorkspacePath | '/$workspaceSlug/agents/new' | '/$workspaceSlug/tables/new';

export type SearchCategory = 'all' | 'pages' | 'chats' | 'agents' | 'tables' | 'workflows' | 'apps' | 'files';
export type ContentCategory = Exclude<SearchCategory, 'all' | 'pages'>;

export type SearchTarget =
  | { kind: 'page'; to: SearchPath }
  | { kind: 'create-workspace' }
  | { kind: 'toggle-sidebar' }
  | { kind: 'chat'; chatId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'table'; tableId: string }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'app'; appSlug: string }
  | { kind: 'file'; fileId: string };

export type StoredRecentEntry = {
  id: string;
  title: string;
  meta?: string | undefined;
  category: 'pages' | 'actions' | ContentCategory;
  target: SearchTarget;
  folder?: boolean | undefined;
};

const storedTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), to: z.string() }),
  z.object({ kind: z.literal('create-workspace') }),
  z.object({ kind: z.literal('toggle-sidebar') }),
  z.object({ kind: z.literal('chat'), chatId: z.string() }),
  z.object({ kind: z.literal('agent'), agentId: z.string() }),
  z.object({ kind: z.literal('table'), tableId: z.string() }),
  z.object({ kind: z.literal('workflow'), workflowId: z.string() }),
  z.object({ kind: z.literal('app'), appSlug: z.string() }),
  z.object({ kind: z.literal('file'), fileId: z.string() }),
]);

const storedRecentsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    meta: z.string().optional(),
    category: z.enum(['pages', 'actions', 'chats', 'agents', 'tables', 'workflows', 'apps', 'files']),
    target: storedTargetSchema,
    folder: z.boolean().optional(),
  }),
);

const recentsStorageKey = (workspaceId: string) => `tf:search-recents:${workspaceId}`;

export function loadStoredRecents(workspaceId: string): StoredRecentEntry[] {
  try {
    const raw = window.localStorage.getItem(recentsStorageKey(workspaceId));
    if (!raw) return [];
    const parsed = storedRecentsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.slice(0, 4) as StoredRecentEntry[];
  } catch {
    return [];
  }
}

export function saveStoredRecents(workspaceId: string, entries: StoredRecentEntry[]) {
  try {
    window.localStorage.setItem(recentsStorageKey(workspaceId), JSON.stringify(entries.slice(0, 4)));
  } catch {
    // Storage may be unavailable in private browsing; ignore quietly.
  }
}

export function matchesWords(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.every(word => lower.includes(word));
}
