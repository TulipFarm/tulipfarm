import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

const documentSchema = z.object({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  failure: z.string().nullable(),
  canRetry: z.boolean(),
  kind: z.enum(['note', 'file']),
  fileId: z.uuid().optional(),
});
export type KnowledgeEntry = z.infer<typeof documentSchema>;

const messages: Record<string, string> = {
  'knowledge-not-found': 'You can’t open this file anymore, or the Knowledge entry was removed.',
  'knowledge-quota': 'Your Knowledge is full, or this file is too large to add.',
  'knowledge-conflict': 'This file changed while it was being added. Try again.',
  'knowledge-unavailable': 'Knowledge isn’t available right now. Try again in a few minutes.',
  'file-integrity': 'TulipFarm couldn’t verify this file’s content. Try again.',
};

/** Personal Knowledge, the only Knowledge destination today. Adding a file queues text extraction; nothing is indexed automatically. */
export function knowledgeApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/documents`;
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
    /** The first page of your Knowledge, used to find files already added. */
    list: async (signal: AbortSignal) =>
      z.object({ items: z.array(documentSchema) }).parse(await request('', 'GET', signal)).items,
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
    retry: async (entry: KnowledgeEntry, commandId: string, signal: AbortSignal) =>
      documentSchema.parse(
        await request(`/${entry.documentId}/retry`, 'POST', signal, {
          commandId,
          expectedRevisionId: entry.revisionId,
        }),
      ),
  };
}
