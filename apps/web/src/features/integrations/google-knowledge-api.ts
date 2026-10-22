import { z } from 'zod';
import {
  googleCorpusBindingSchema,
  googleCorpusKindSchema,
  googleCorpusSelectionSchema,
} from '@tulipfarm/google-workspace/corpus-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { KnowledgeRequestError } from './knowledge-request-error';

const sourceSchema = z.object({
  sourceId: z.uuid(),
  selection: googleCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()),
  title: z.string(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().nullable(),
  nextAttemptAt: z.iso.datetime(),
  counts: z
    .object({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
  canManage: z.boolean(),
});
const choiceSchema = z.object({ nativeId: z.string(), title: z.string(), kind: googleCorpusKindSchema });
const discoverySchema = z.object({
  binding: googleCorpusBindingSchema,
  items: z.array(choiceSchema),
  nextCursor: z.string().nullable(),
});
const refreshSchema = z.object({
  refreshed: z.number().int().min(0).max(20),
  unavailable: z.number().int().min(0).max(20),
  bounded: z.literal(true),
});
const googleDocumentSchema = z.object({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  publicationId: z.uuid().nullable(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  embedding: z.enum(['pending', 'failed', 'credits-blocked', 'ready']),
  failure: z.string().nullable(),
  validUntil: z.iso.datetime(),
  canRetry: z.boolean(),
});
export type GoogleDocument = z.infer<typeof googleDocumentSchema>;
export type GoogleSource = z.infer<typeof sourceSchema>;
export type GoogleKind = z.infer<typeof googleCorpusKindSchema>;
export type GoogleChoice = z.infer<typeof choiceSchema>;
export type ConfigureGoogle = {
  commandId: string;
  selection: z.infer<typeof googleCorpusSelectionSchema>;
  memberIds: string[];
};
export type ManageGoogle = { commandId: string; action: 'pause' | 'resume' | 'retry' | 'remove' };
export { googleCorpusSelectionSchema, googleCorpusKindSchema };

export const googleErrorMessages: Record<string, string> = {
  'google-reconnect-required': 'Reconnect Google, then try again.',
  'google-stale-integration': 'Your Google integration changed. Reload the list, then try again.',
  'google-insufficient-scope':
    'Your Google integration does not include this app. Connect Google Drive or Gmail in Integrations, then try again.',
  'google-unauthenticated': 'Google rejected your integration. Reconnect Google, then try again.',
  'google-credential-unavailable': 'Your Google integration is unavailable. Reconnect Google, then try again.',
  'google-rate-limited': 'Google is limiting requests. Wait a minute, then try again.',
  'google-incomplete-search': 'Google returned an incomplete folder list. Try again in a moment.',
  'google-invalid-selection': 'Choose a folder or drive, and for Gmail a date range of at most 366 days.',
};

export class GoogleKnowledgeError extends KnowledgeRequestError {
  constructor(status: number, code: string) {
    super(status, code, code);
    this.message =
      googleErrorMessages[code] ??
      (status === 409
        ? 'This source changed. Check source status before trying again.'
        : status === 400
          ? 'The source selection was rejected. Check the selected scope, dates, and members.'
          : status === 413
            ? 'This selection exceeds the Knowledge limit. Choose a smaller folder.'
            : [401, 403, 404].includes(status)
              ? 'This source or Google connection is unavailable to you. Check your connection and source access.'
              : 'Could not confirm the Google request. Check your connection and try again.');
  }
}

export function googleKnowledgeApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/google`;
  async function request(path: string, method: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      body,
      signal: requestSignal(signal),
      cache: 'no-store',
    });
    const value = await readJson(response, !response.ok);
    if (!response.ok) throw new GoogleKnowledgeError(response.status, responseError(value, 'unavailable'));
    return value;
  }
  return {
    members: async (signal: AbortSignal) =>
      z
        .object({ members: z.array(z.object({ id: z.uuid(), name: z.string(), email: z.email() })) })
        .parse(await request('/members', 'GET', signal)),
    documents: async (sourceId: string, cursor: string | null, signal: AbortSignal) =>
      z
        .object({ items: z.array(googleDocumentSchema), nextCursor: z.string().nullable() })
        .parse(
          await request(
            `/sources/${encodeURIComponent(sourceId)}/documents${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
            'GET',
            signal,
          ),
        ),
    discover: async (kind: GoogleKind, cursor: string | null, signal: AbortSignal) =>
      discoverySchema.parse(
        await request(`/discover?${new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) })}`, 'GET', signal),
      ),
    list: async (signal: AbortSignal) =>
      z.object({ items: z.array(sourceSchema) }).parse(await request('/sources', 'GET', signal)),
    configure: async (input: ConfigureGoogle, signal: AbortSignal) =>
      sourceSchema.parse(await request('/sources', 'POST', signal, input)),
    manage: async (sourceId: string, input: ManageGoogle, signal: AbortSignal) =>
      sourceSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/manage`, 'POST', signal, input)),
    refresh: async (sourceId: string, signal: AbortSignal) =>
      refreshSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/refresh`, 'POST', signal)),
  };
}
export type GoogleKnowledgeApi = ReturnType<typeof googleKnowledgeApi>;
export const googleSourceKeys = ['integrations', 'google', 'content', 'knowledge-sources'];
export const googleConcealKeys = [googleSourceKeys];
