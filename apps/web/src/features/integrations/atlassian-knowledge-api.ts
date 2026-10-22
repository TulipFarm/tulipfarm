import { z } from 'zod';
import {
  atlassianCorpusBindingSchema,
  atlassianCorpusSelectionSchema,
  atlassianProductSchema,
  atlassianTargetKey,
  atlassianTargetKindSchema,
} from '@tulipfarm/knowledge/atlassian-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { KnowledgeRequestError } from './knowledge-request-error';

const targetSchema = z.object({
  kind: atlassianTargetKindSchema,
  id: z.string(),
  key: z.string().nullable(),
  title: z.string(),
});
const sourceSchema = z.object({
  sourceId: z.uuid(),
  product: atlassianProductSchema,
  selection: atlassianCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()),
  title: z.string(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().nullable(),
  nextAttemptAt: z.iso.datetime(),
  targets: z
    .array(
      targetSchema.extend({
        descendants: z.boolean(),
        state: z.enum(['active', 'unavailable']),
        failure: z.string().nullable(),
      }),
    )
    .nullable(),
  counts: z
    .object({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
  canManage: z.boolean(),
});
const discoverySchema = z.object({
  binding: atlassianCorpusBindingSchema,
  items: z.array(targetSchema),
  nextCursor: z.string().nullable(),
});
const refreshSchema = z.object({
  refreshed: z.number().int().min(0).max(100),
  unavailable: z.number().int().min(0).max(100),
  bounded: z.literal(true),
});
const documentSchema = z.object({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string(),
  publicationId: z.uuid().nullable(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  embedding: z.enum(['pending', 'failed', 'credits-blocked', 'ready']),
  failure: z.string().nullable(),
  historical: z.boolean().default(false),
  validUntil: z.iso.datetime(),
  canRetry: z.boolean(),
});
export type AtlassianDocument = z.infer<typeof documentSchema>;
export type AtlassianSource = z.infer<typeof sourceSchema>;
export type AtlassianProduct = z.infer<typeof atlassianProductSchema>;
export type AtlassianTargetChoice = z.infer<typeof targetSchema>;
export type AtlassianSelection = z.infer<typeof atlassianCorpusSelectionSchema>;
export type ConfigureAtlassian = { commandId: string; selection: AtlassianSelection; memberIds: string[] };
export type ManageAtlassian = { commandId: string; action: 'pause' | 'resume' | 'retry' | 'remove' };
export type DiscoverKind = 'spaces' | 'pages' | 'projects';
export { atlassianCorpusSelectionSchema, atlassianTargetKey };

export const atlassianErrorMessages: Record<string, string> = {
  'atlassian-not-configured':
    'Confluence and Jira knowledge is not configured for this workspace yet. Ask a workspace admin to finish the Atlassian REST setup.',
  'atlassian-not-linked':
    'Connect your own Atlassian account with the REST sign-in under Advanced setup, then try again.',
  'atlassian-reconnect-required': 'Your Atlassian sign-in expired. Reconnect your Atlassian account, then retry.',
  'atlassian-stale-integration': 'Your Atlassian account changed. Reload the list, then retry.',
  'atlassian-insufficient-scope':
    'Your Atlassian sign-in does not allow reading this content. Reconnect with Confluence page or Jira work read access.',
  'atlassian-unauthenticated': 'Atlassian rejected your sign-in. Reconnect your Atlassian account, then retry.',
  'atlassian-forbidden': 'You cannot view one of these selections in Atlassian.',
  'atlassian-not-found': 'One of these selections no longer exists or is hidden from you in Atlassian.',
  'atlassian-rate-limited': 'Atlassian is limiting requests. Wait a minute, then try again.',
  'atlassian-invalid-selection': 'Choose at least one space, page, or project from one site.',
};

export class AtlassianKnowledgeError extends KnowledgeRequestError {
  constructor(status: number, code: string) {
    super(
      status,
      code,
      atlassianErrorMessages[code] ??
        (status === 409
          ? 'This source changed. Check source status before trying again.'
          : status === 400
            ? 'The source selection was rejected. Check the selection and members.'
            : status === 413
              ? 'This selection exceeds the Knowledge limit. Choose fewer items.'
              : [401, 403, 404].includes(status)
                ? 'This source or Atlassian account is unavailable to you. Check your Atlassian account and source access.'
                : 'Could not confirm the Atlassian request. Check your connection and try again.'),
    );
  }
}

export function atlassianKnowledgeApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/atlassian`;
  async function request(path: string, method: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      body,
      signal: requestSignal(signal),
      cache: 'no-store',
    });
    const value = await readJson(response, !response.ok);
    if (!response.ok) throw new AtlassianKnowledgeError(response.status, responseError(value, 'unavailable'));
    return value;
  }
  return {
    members: async (signal: AbortSignal) =>
      z
        .object({ members: z.array(z.object({ id: z.uuid(), name: z.string(), email: z.email() })) })
        .parse(await request('/members', 'GET', signal)),
    sites: async (signal: AbortSignal) =>
      z
        .object({ items: z.array(z.object({ cloudId: z.uuid(), name: z.string(), url: z.url() })) })
        .parse(await request('/sites', 'GET', signal)),
    documents: async (sourceId: string, cursor: string | null, signal: AbortSignal) =>
      z
        .object({ items: z.array(documentSchema), nextCursor: z.string().nullable() })
        .parse(
          await request(
            `/sources/${encodeURIComponent(sourceId)}/documents${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
            'GET',
            signal,
          ),
        ),
    discover: async (
      cloudId: string,
      kind: DiscoverKind,
      within: string | null,
      cursor: string | null,
      signal: AbortSignal,
    ) =>
      discoverySchema.parse(
        await request(
          `/discover?${new URLSearchParams({ cloudId, kind, ...(within ? { within } : {}), ...(cursor ? { cursor } : {}) })}`,
          'GET',
          signal,
        ),
      ),
    list: async (signal: AbortSignal) =>
      z.object({ items: z.array(sourceSchema) }).parse(await request('/sources', 'GET', signal)),
    configure: async (input: ConfigureAtlassian, signal: AbortSignal) =>
      sourceSchema.parse(await request('/sources', 'POST', signal, input)),
    manage: async (sourceId: string, input: ManageAtlassian, signal: AbortSignal) =>
      sourceSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/manage`, 'POST', signal, input)),
    refresh: async (sourceId: string, signal: AbortSignal) =>
      refreshSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/refresh`, 'POST', signal)),
    async original(documentId: string, revisionId: string, signal: AbortSignal) {
      const response = await fetch(
        `${base}/documents/${encodeURIComponent(documentId)}/original?${new URLSearchParams({ revisionId })}`,
        { credentials: 'include', signal: requestSignal(signal), cache: 'no-store' },
      );
      if (!response.ok) throw new AtlassianKnowledgeError(response.status, 'unavailable');
      const blob = await response.blob();
      const encoded = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      let filename = 'atlassian-item.md';
      try {
        if (encoded) filename = decodeURIComponent(encoded);
      } catch {
        /* The server name is optional; keep the safe default. */
      }
      return { blob, filename };
    },
  };
}
export type AtlassianKnowledgeApi = ReturnType<typeof atlassianKnowledgeApi>;
export const atlassianSourceKeys = ['integrations', 'atlassian', 'content', 'knowledge-sources'];
export const atlassianConcealKeys = [atlassianSourceKeys];
