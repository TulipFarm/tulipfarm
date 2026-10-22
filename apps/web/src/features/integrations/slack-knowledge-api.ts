import { z } from 'zod';
import {
  slackCorpusBindingSchema,
  slackCorpusKindSchema,
  slackCorpusSelectionSchema,
  slackConversationKindSchema,
} from '@tulipfarm/knowledge/slack-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { KnowledgeRequestError } from './knowledge-request-error';

const conversationSchema = z.object({
  conversationId: z.string(),
  kind: slackConversationKindSchema,
  title: z.string(),
});
const sourceSchema = z.object({
  sourceId: z.uuid(),
  selection: slackCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()),
  title: z.string(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().nullable(),
  nextAttemptAt: z.iso.datetime(),
  conversations: z
    .array(conversationSchema.extend({ state: z.enum(['active', 'unavailable']), failure: z.string().nullable() }))
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
  binding: slackCorpusBindingSchema,
  items: z.array(conversationSchema),
  nextCursor: z.string().nullable(),
});
const refreshSchema = z.object({
  refreshed: z.number().int().min(0).max(20),
  unavailable: z.number().int().min(0).max(20),
  bounded: z.literal(true),
});
const slackDocumentSchema = z.object({
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
export type SlackDocument = z.infer<typeof slackDocumentSchema>;
export type SlackSource = z.infer<typeof sourceSchema>;
export type SlackSelection = z.infer<typeof slackCorpusSelectionSchema>;
export type SlackKind = z.infer<typeof slackCorpusKindSchema>;
export type SlackConversationChoice = z.infer<typeof conversationSchema>;
export type ConfigureSlack = { commandId: string; selection: SlackSelection; memberIds: string[] };
export type ManageSlack = { commandId: string; action: 'pause' | 'resume' | 'retry' | 'remove' };
export { slackCorpusSelectionSchema, slackCorpusKindSchema };

export const slackErrorMessages: Record<string, string> = {
  'slack-not-configured':
    'Slack knowledge is not configured for this workspace yet. Ask a Slack integration manager to finish Slack setup.',
  'slack-not-linked':
    'Link your Slack account first. Slack sends you a link prompt when you message the TulipFarm app.',
  'slack-reconnect-required': 'Your Slack link expired. Link your Slack account again, then retry.',
  'slack-stale-integration': 'Your Slack link changed. Reload the conversation list, then retry.',
  'slack-insufficient-scope':
    'Your Slack link does not allow reading this kind of conversation. Relink Slack with history access.',
  'slack-unauthenticated': 'Slack rejected your link. Link your Slack account again, then retry.',
  'slack-archived': 'An archived conversation cannot be selected. Choose an active conversation.',
  'slack-not-member': 'You are not a member of one of these conversations in Slack.',
  'slack-wrong-kind': 'This conversation type does not match the selected source type.',
  'slack-rate-limited': 'Slack is limiting requests. Wait a minute, then try again.',
  'slack-invalid-selection': 'Choose an after date within the last 366 days.',
};

export class SlackKnowledgeError extends KnowledgeRequestError {
  constructor(status: number, code: string) {
    super(status, code, code);
    this.message =
      slackErrorMessages[code] ??
      (status === 409
        ? 'This source changed. Check source status before trying again.'
        : status === 400
          ? 'The source selection was rejected. Check the conversations, date, and members.'
          : status === 413
            ? 'This selection exceeds the Knowledge limit. Choose fewer conversations.'
            : [401, 403, 404].includes(status)
              ? 'This source or Slack link is unavailable to you. Check your Slack link and source access.'
              : 'Could not confirm the Slack request. Check your connection and try again.');
  }
}

export function slackKnowledgeApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/slack`;
  async function request(path: string, method: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      body,
      signal: requestSignal(signal),
      cache: 'no-store',
    });
    const value = await readJson(response, !response.ok);
    if (!response.ok) throw new SlackKnowledgeError(response.status, responseError(value, 'unavailable'));
    return value;
  }
  return {
    members: async (signal: AbortSignal) =>
      z
        .object({ members: z.array(z.object({ id: z.uuid(), name: z.string(), email: z.email() })) })
        .parse(await request('/members', 'GET', signal)),
    documents: async (sourceId: string, cursor: string | null, signal: AbortSignal) =>
      z
        .object({ items: z.array(slackDocumentSchema), nextCursor: z.string().nullable() })
        .parse(
          await request(
            `/sources/${encodeURIComponent(sourceId)}/documents${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
            'GET',
            signal,
          ),
        ),
    discover: async (kind: SlackKind, cursor: string | null, signal: AbortSignal) =>
      discoverySchema.parse(
        await request(`/discover?${new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) })}`, 'GET', signal),
      ),
    list: async (signal: AbortSignal) =>
      z.object({ items: z.array(sourceSchema) }).parse(await request('/sources', 'GET', signal)),
    configure: async (input: ConfigureSlack, signal: AbortSignal) =>
      sourceSchema.parse(await request('/sources', 'POST', signal, input)),
    manage: async (sourceId: string, input: ManageSlack, signal: AbortSignal) =>
      sourceSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/manage`, 'POST', signal, input)),
    refresh: async (sourceId: string, signal: AbortSignal) =>
      refreshSchema.parse(await request(`/sources/${encodeURIComponent(sourceId)}/refresh`, 'POST', signal)),
    async original(documentId: string, revisionId: string, signal: AbortSignal) {
      const response = await fetch(
        `${base}/documents/${encodeURIComponent(documentId)}/original?${new URLSearchParams({ revisionId })}`,
        { credentials: 'include', signal: requestSignal(signal), cache: 'no-store' },
      );
      if (!response.ok) throw new SlackKnowledgeError(response.status, 'unavailable');
      const blob = await response.blob();
      const encoded = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      let filename = 'slack-thread.md';
      try {
        if (encoded) filename = decodeURIComponent(encoded);
      } catch {
        /* The server name is optional; keep the safe default. */
      }
      return { blob, filename };
    },
  };
}
export type SlackKnowledgeApi = ReturnType<typeof slackKnowledgeApi>;
export const slackSourceKeys = ['integrations', 'slack', 'content', 'knowledge-sources'];
export const slackConcealKeys = [slackSourceKeys];
