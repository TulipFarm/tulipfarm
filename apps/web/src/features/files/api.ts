import { useMemo } from 'react';
import { z } from 'zod';
import {
  deletionOutcomeSchema,
  deletionPreviewSchema,
  fileDetailsSchema,
  fileDirectorySchema,
  fileSharingSnapshotSchema,
  fileSuggestionsPageSchema,
  fileStorageUsageSchema,
  fileSummarySchema,
  libraryPageSchema,
  movePreviewSchema,
  type FileRole,
  type FileSubject,
  type FileSummary,
  type LibraryFilters,
  type LibraryItem,
  type LibraryQuery,
  type LibrarySort,
} from '@tulipfarm/files/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { useFeatureChanges } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';
import type { FilesSearch } from './search.ts';
export {
  filesViewSchema,
  modifiedPresets,
  filesSearchSchema,
  viewerSearchSchema,
  type FilesView,
  type FilesSearch,
  type ViewerSearch,
} from './search.ts';
export const filterKeys = ['type', 'owner', 'modified', 'from', 'to'] as const satisfies readonly (keyof FilesSearch)[];
export const filtered = (search: FilesSearch) => filterKeys.some(key => search[key] !== undefined);
export const librarySort = (search: FilesSearch): LibrarySort => ({
  key: search.sort ?? 'name',
  direction: search.order ?? (search.sort === 'modified' ? 'desc' : 'asc'),
});

const localDay = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
};
/** Local-day bounds, so a preset stays one cache key for the whole day. */
export function libraryFilters(search: FilesSearch, today = new Date()): LibraryFilters {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysAgo = (days: number) => new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - days);
  const from =
    search.modified === 'today'
      ? midnight
      : search.modified === 'week'
        ? daysAgo(6)
        : search.modified === 'month'
          ? daysAgo(29)
          : search.modified === 'year'
            ? new Date(midnight.getFullYear(), 0, 1)
            : search.modified === 'custom' && search.from
              ? localDay(search.from)
              : undefined;
  const through = search.modified === 'custom' && search.to ? localDay(search.to) : undefined;
  const before = through && new Date(through.getFullYear(), through.getMonth(), through.getDate() + 1);
  return {
    ...(search.type ? { type: search.type } : {}),
    ...(search.owner ? { owner: search.owner } : {}),
    ...(from ? { modifiedFrom: from.toISOString() } : {}),
    ...(before ? { modifiedBefore: before.toISOString() } : {}),
  };
}
export const maxUploadBytes = 10 * 1024 * 1024;

export const fileKeys = {
  all: ['files'] as const,
  library: (query: LibraryQuery) => ['files', 'library', query] as const,
  item: (id: string) => ['files', 'item', id] as const,
  details: (id: string) => ['files', 'details', id] as const,
  sharing: (id: string) => ['files', 'sharing', id] as const,
  directory: (id: string) => ['files', 'directory', id] as const,
  usage: ['files', 'usage'] as const,
  deletion: (id: string) => ['files', 'deletion', id] as const,
};

const messages: Record<string, string> = {
  'file-not-found': 'This item is unavailable, or your access changed.',
  'file-conflict': 'This item changed while you were working. Refresh the list and try again.',
  'file-quota': 'Workspace storage is full. Files in Trash still use storage.',
  'file-size': 'This file is empty or larger than the 10 MB upload limit.',
  'file-busy': 'Several transfers are already running. Try this one again in a moment.',
  'invalid-request': 'Check the name. Names cannot contain slashes or control characters.',
  'file-invalid-move': 'A folder can’t move into itself or into a folder inside it.',
  'file-invalid-cursor': 'This page link no longer works. Showing the first page.',
  'file-graph-limit':
    'This folder holds too many items or grants to check access changes. Move smaller folders instead.',
  'file-not-owner': 'Only the person who owns this item can delete it forever. You can still restore it.',
  'file-owned-by-others':
    'This folder now holds items owned by other people. Review it again before deleting it forever.',
  'file-not-trashed': 'This item is no longer in Trash. Move it to Trash before deleting it forever.',
  'file-restore-destination':
    'Its original folder is in Trash, or you can no longer add to it. Choose where to restore it.',
  'files-unavailable': 'Files are being updated. Try again in a few minutes.',
  'session-changed': 'Your session changed before the upload finished. Sign in again to retry.',
};

async function send(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal }) {
  const response = await jsonResponse(path, { ...options, signal: requestSignal(options.signal), cache: 'no-store' });
  if (!response.ok) {
    const code = responseError(await readJson(response, true), 'file-operation-failed');
    throw new TableRequestError(
      response.status,
      code,
      messages[code] ?? 'The file operation could not be completed. Check your connection and try again.',
    );
  }
  return response;
}

export function filesApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/files`;
  const item = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const summary = async (response: Response) => fileSummarySchema.parse(await readJson(response));
  return {
    async library(query: LibraryQuery, signal: AbortSignal) {
      const search = new URLSearchParams({
        section: query.section,
        query: query.query,
        sort: query.sort.key,
        order: query.sort.direction,
      });
      for (const [key, value] of Object.entries(query.filters)) if (value !== undefined) search.set(key, value);
      if (query.location.kind === 'folder') search.set('folder', query.location.id);
      if (query.after) search.set('after', query.after);
      return libraryPageSchema.parse(await readJson(await send(`${base}/library?${search}`, { signal })));
    },
    read: async (id: string, signal: AbortSignal) => summary(await send(item(id), { signal })),
    /** Readable items among `ids` (at most 100); missing or unreadable ids are left out. */
    summaries: async (ids: readonly string[], signal: AbortSignal) =>
      z
        .object({ items: z.array(fileSummarySchema) })
        .parse(await readJson(await send(`${base}/summaries?ids=${ids.join(',')}`, { signal }))).items,
    suggestions: async (query: string, signal: AbortSignal, after?: string) => {
      const search = new URLSearchParams({ query });
      if (after) search.set('after', after);
      return fileSuggestionsPageSchema.parse(await readJson(await send(`${base}/suggestions?${search}`, { signal })));
    },
    // eslint-disable-next-line tulipfarm/product-copy -- Stable API identifiers are not user-facing copy.
    recordRecentUse: async (id: string) => {
      await send(`${item(id)}/recent-use`, { method: 'POST' });
    },
    /** Readable, untrashed files and folders whose names contain the query, across the workspace. */
    search: async (query: string, signal: AbortSignal) =>
      z
        .object({ items: z.array(fileSummarySchema) })
        .parse(await readJson(await send(`${base}?${new URLSearchParams({ query })}`, { signal }))).items,
    content: async (id: string, signal: AbortSignal) => (await send(`${item(id)}/content`, { signal })).arrayBuffer(),
    createFolder: async (id: string, name: string, parentId: string | null) =>
      summary(await send(`${item(id)}/folder`, { method: 'PUT', body: { name, parentId } })),
    rename: async (id: string, name: string) => summary(await send(item(id), { method: 'PATCH', body: { name } })),
    trash: async (id: string, trashed: boolean) => {
      await send(`${item(id)}/trash`, { method: 'PUT', body: { trashed } });
    },
    usage: async (signal: AbortSignal) =>
      fileStorageUsageSchema.parse(await readJson(await send(`${base}/usage`, { signal }))),
    previewDeletion: async (id: string, signal: AbortSignal) =>
      deletionPreviewSchema.parse(await readJson(await send(`${item(id)}/deletion`, { signal }))),
    deleteForever: async (id: string) =>
      deletionOutcomeSchema.parse(await readJson(await send(`${item(id)}/delete-forever`, { method: 'POST' }))),
    details: async (id: string, signal: AbortSignal) =>
      fileDetailsSchema.parse(await readJson(await send(`${item(id)}/details`, { signal }))),
    directory: async (id: string, signal: AbortSignal) =>
      fileDirectorySchema.parse(await readJson(await send(`${item(id)}/directory`, { signal }))),
    sharing: async (id: string, signal: AbortSignal) =>
      fileSharingSnapshotSchema.parse(await readJson(await send(`${item(id)}/sharing`, { signal }))),
    share: async (id: string, subject: FileSubject, role: FileRole | null) => {
      await send(`${item(id)}/sharing`, { method: 'PUT', body: { subject, role } });
    },
    previewMove: async (id: string, parentId: string | null) =>
      movePreviewSchema.parse(
        await readJson(await send(`${item(id)}/move-audience`, { method: 'POST', body: { parentId } })),
      ),
    move: async (id: string, parentId: string | null, fingerprint: string) => {
      await send(`${item(id)}/parent`, { method: 'PUT', body: { parentId, fingerprint } });
    },
    /**
     * Sends the bytes with XMLHttpRequest because fetch reports no upload progress. `progress` receives bytes sent so far;
     * aborting `signal` aborts the request, which the server treats as a cancelled upload.
     */
    upload(
      id: string,
      file: File,
      parentId: string | null,
      expectedSessionId: string,
      signal: AbortSignal,
      progress: (sent: number) => void = () => undefined,
    ) {
      const search = new URLSearchParams({
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        parentId: parentId ?? 'null',
      });
      return new Promise<FileSummary>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const settle = (outcome: () => void) => {
          signal.removeEventListener('abort', abort);
          outcome();
        };
        xhr.open('PUT', `${item(id)}/content?${search}`);
        xhr.withCredentials = true;
        xhr.timeout = 120_000;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-TulipFarm-Expected-Session', expectedSessionId);
        xhr.upload.addEventListener('progress', event => progress(Math.min(event.loaded, file.size)));
        xhr.addEventListener('load', () =>
          settle(() => {
            let body: unknown = null;
            try {
              body = JSON.parse(xhr.responseText);
            } catch {
              /* A proxy can answer with a non-JSON error page. */
            }
            if (xhr.status >= 200 && xhr.status < 300) {
              const parsed = fileSummarySchema.safeParse(body);
              if (parsed.success) resolve(parsed.data);
              else reject(new Error('file-response-invalid'));
              return;
            }
            const code = responseError(body, 'file-operation-failed');
            reject(
              new TableRequestError(
                xhr.status,
                code,
                messages[code] ??
                  'The upload could not be confirmed. Retry sends the same file again without creating a copy.',
              ),
            );
          }),
        );
        xhr.addEventListener('error', () => settle(() => reject(new TypeError('upload-network-failed'))));
        xhr.addEventListener('timeout', () =>
          settle(() => reject(new DOMException('The upload timed out.', 'TimeoutError'))),
        );
        xhr.addEventListener('abort', () =>
          settle(() => reject(new DOMException('The upload was cancelled.', 'AbortError'))),
        );
        if (signal.aborted) {
          reject(new DOMException('The upload was cancelled.', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        xhr.send(file);
      });
    },
  };
}
export type FilesApi = ReturnType<typeof filesApi>;
export type { FileSummary };
export const roleLabels: Record<FileRole, string> = { viewer: 'Can view', editor: 'Can edit', manager: 'Can manage' };
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }),
  time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
/** A modified time for display. Files added before modified times were recorded have none, shown as unknown rather than their created time. */
export function modifiedText(at: string | null, today = new Date()) {
  if (at === null) return 'unknown';
  const date = new Date(at);
  return date.toDateString() === today.toDateString() ? time.format(date) : day.format(date);
}
/** Where a search result sits. A top-level item names My files only for its owner; another owner's top level adds nothing. */
export function place(
  item: Pick<LibraryItem, 'parentId' | 'parentName' | 'creatorMembershipId'>,
  membershipId: string,
) {
  if (item.parentName) return `In ${item.parentName}`;
  if (item.parentId !== null) return 'In a folder you can’t open';
  return item.creatorMembershipId === membershipId ? 'In My files' : null;
}
export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof TableRequestError ? error.message : fallback;

/** The stable address of an item. Opening it still requires access. */
export function fileUrl(workspaceSlug: string, item: Pick<FileSummary, 'id' | 'kind'>) {
  const path = `/${encodeURIComponent(workspaceSlug)}/files`;
  return new URL(item.kind === 'folder' ? `${path}?folder=${item.id}` : `${path}/${item.id}`, window.location.origin)
    .href;
}

export function useFilesApi(workspaceId: string) {
  return useMemo(() => filesApi(workspaceId), [workspaceId]);
}
export function useFilesChanges() {
  const { change } = useFeatureChanges();
  return useMemo(
    () => ({
      changed: () => change({ keys: [fileKeys.all] }),
      concealed: () => change({ kind: 'conceal', keys: [fileKeys.all] }),
    }),
    [change],
  );
}
