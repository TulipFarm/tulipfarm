import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { KnowledgeRequestError } from './knowledge-request-error';

const failureSchema = z.object({
  documentId: z.uuid(),
  title: z.string(),
  canonicalUrl: z.string().nullable(),
  status: z.enum(['failed', 'ocr-unavailable', 'raw-text']),
  reason: z.string(),
  attempts: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(),
});
const failuresSchema = z.object({
  sourceId: z.uuid(),
  syncedAt: z.iso.datetime().nullable(),
  items: z.array(failureSchema),
  truncated: z.boolean(),
});
export type KnowledgeSourceFailure = z.infer<typeof failureSchema>;
export type KnowledgeSourceFailures = z.infer<typeof failuresSchema>;
export type KnowledgeSourceFailuresApi = ReturnType<typeof knowledgeSourceFailuresApi>;
export const knowledgeSourceFailureKeys = ['knowledge', 'source-failures'] as const;

export function knowledgeSourceFailuresApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/sources`;
  return {
    list: async (sourceId: string, signal: AbortSignal) => {
      const response = await jsonResponse(`${base}/${encodeURIComponent(sourceId)}/failures`, {
        method: 'GET',
        signal: requestSignal(signal),
        cache: 'no-store',
      });
      const value = await readJson(response, !response.ok);
      if (!response.ok) {
        const code = responseError(value, 'unavailable');
        throw new KnowledgeRequestError(response.status, code, code);
      }
      return failuresSchema.parse(value);
    },
  };
}
