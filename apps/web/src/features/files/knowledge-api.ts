import { z } from 'zod';
import { knowledgeSearchResultSchema, type KnowledgeSave } from '@tulipfarm/knowledge/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

/** Parts of a document that could not be read: the full count and the first few. */
export const knowledgeGapsSchema = z.object({
  count: z.number().int().min(0),
  items: z.array(z.object({ kind: z.string(), reason: z.string(), label: z.string() })),
});

const documentSchema = z.object({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  failure: z.string().nullable(),
  canRetry: z.boolean(),
  gaps: knowledgeGapsSchema.optional(),
  kind: z.enum(['note', 'file']),
  fileId: z.uuid().optional(),
  noteText: z.string().optional(),
});
export type KnowledgeEntry = z.infer<typeof documentSchema>;

const messages: Record<string, string> = {
  'knowledge-not-found': 'You can’t open this entry anymore, or it was removed.',
  'knowledge-quota': 'Your Knowledge is full, or this file is too large to add.',
  'knowledge-conflict':
    'This entry changed while you were working. Close this dialog, refresh the list, and try again.',
  'knowledge-superseded': 'This entry has a newer revision. Close this dialog, refresh the list, and try again.',
  'knowledge-unavailable': 'Knowledge isn’t available right now. Try again in a few minutes.',
  'file-integrity': 'TulipFarm couldn’t verify this file’s content. Try again.',
};

export const personalKnowledgeKeys = ['knowledge', 'personal'] as const;

export function knowledgeApi(workspaceId: string) {
  const knowledge = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge`;
  const base = `${knowledge}/documents`;
  async function request(path: string, method: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      signal,
      cache: 'no-store',
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) {
      const code = responseError(await readJson(response, true), 'knowledge-operation-failed');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ?? 'Couldn’t reach Knowledge. Check your connection and try again.',
      );
    }
    return readJson(response);
  }
  return {
    list: async (signal: AbortSignal) => {
      const entries: KnowledgeEntry[] = [];
      let cursor: string | null = null;
      do {
        const page = z
          .object({ items: z.array(documentSchema), nextCursor: z.uuid().nullable().default(null) })
          .parse(await request(cursor ? `?cursor=${cursor}` : '', 'GET', signal));
        entries.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return entries;
    },
    get: async (documentId: string, signal: AbortSignal) =>
      documentSchema.parse(await request(`/${documentId}`, 'GET', signal)),
    add: async (input: { documentId: string; commandId: string; title: string; fileId: string }, signal: AbortSignal) =>
      documentSchema.parse(
        await request(`/${input.documentId}`, 'PUT', signal, {
          commandId: input.commandId,
          expectedRevisionId: null,
          title: input.title,
          input: { kind: 'file', fileId: input.fileId },
        }),
      ),
    save: async ({ documentId, ...body }: KnowledgeSave, signal: AbortSignal) =>
      documentSchema.parse(await request(`/${documentId}`, 'PUT', signal, body)),
    remove: async (entry: KnowledgeEntry, commandId: string, signal: AbortSignal) =>
      request(`/${entry.documentId}/remove`, 'POST', signal, {
        commandId,
        expectedRevisionId: entry.revisionId,
      }),
    search: async (query: string, signal: AbortSignal) => {
      const response = await jsonResponse(`${knowledge}/search?${new URLSearchParams({ query })}`, {
        method: 'GET',
        signal,
        cache: 'no-store',
      });
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          'knowledge-search-failed',
          'Could not search Knowledge. Try again.',
        );
      return knowledgeSearchResultSchema.parse(await readJson(response));
    },
    retry: async (entry: KnowledgeEntry, commandId: string, signal: AbortSignal) =>
      documentSchema.parse(
        await request(`/${entry.documentId}/retry`, 'POST', signal, {
          commandId,
          expectedRevisionId: entry.revisionId,
        }),
      ),
  };
}
