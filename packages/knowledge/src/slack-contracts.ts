import { z } from 'zod';
import { knowledgeCitationSchema } from './contracts.ts';

export const slackCorpusLimits = Object.freeze({
  conversations: 50,
  historyPageSize: 20,
  threadMessages: 1000,
  threadPages: 5,
  markdownBytes: 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 8000,
  windowDays: 366,
});
export const slackConversationIdSchema = z.string().regex(/^[CDG][A-Z0-9]{2,63}$/);
export const slackTimestampSchema = z.string().regex(/^\d{1,16}\.\d{6}$/);
export const slackCorpusCursorTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
export const slackCorpusKindSchema = z.enum(['channels', 'personal']);
export const slackConversationKindSchema = z.enum(['public', 'private', 'im', 'mpim']);
export const slackCorpusSelectionSchema = z.strictObject({
  kind: slackCorpusKindSchema,
  conversationIds: z
    .array(slackConversationIdSchema)
    .min(1)
    .max(slackCorpusLimits.conversations)
    .refine(
      ids => new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || (ids[index - 1] ?? '') < id),
      'Conversation IDs must be unique and sorted',
    ),
  after: z.iso.date(),
  // Automatic sources keep a rolling window: the engine moves `after` forward on every pass.
  window: z.literal('rolling-90d').optional(),
});
export const slackCorpusBindingSchema = z.strictObject({
  installationId: z.uuid(),
  installationGeneration: z.number().int().positive(),
  identityId: z.uuid(),
  slackUserId: z.string().regex(/^[UW][A-Z0-9]{1,63}$/),
  teamId: z.string().regex(/^[TE][A-Z0-9]{1,63}$/),
});
export const slackCorpusErrorCodeSchema = z.enum([
  'not-configured',
  'not-linked',
  'stale-integration',
  'reconnect-required',
  'insufficient-scope',
  'unauthenticated',
  'forbidden',
  'not-member',
  'archived',
  'not-found',
  'outside-selection',
  'wrong-kind',
  'rate-limited',
  'transient',
  'invalid-response',
  'response-too-large',
  'invalid-cursor',
  'invalid-selection',
  'source-changed',
  'thread-too-large',
]);
export type SlackCorpusErrorCode = z.infer<typeof slackCorpusErrorCodeSchema>;
export class SlackCorpusError extends Error {
  readonly code: SlackCorpusErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: SlackCorpusErrorCode, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'SlackCorpusError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
export type SlackCorpusSelection = z.infer<typeof slackCorpusSelectionSchema>;
export type SlackCorpusKind = z.infer<typeof slackCorpusKindSchema>;
export type SlackConversationKind = z.infer<typeof slackConversationKindSchema>;
export type SlackCorpusBinding = z.infer<typeof slackCorpusBindingSchema>;
/** A Slack account is stable across installation generations and identity rows, so automatic policy follows the person, not the credential. */
export const slackAccountKey = (binding: Pick<SlackCorpusBinding, 'teamId' | 'slackUserId'>) =>
  `${binding.teamId}:${binding.slackUserId}`;
export type SlackConversation = { conversationId: string; kind: SlackConversationKind; title: string };
export type SlackConversationAccess = SlackConversation & { accessedAt: string; member: boolean; archived: boolean };
export type SlackThreadObservation = {
  nativeId: string;
  conversationId: string;
  ts: string;
  title: string;
  canonicalURL: string;
  sourceRevision: string;
  accessedAt: string;
  coverage: 'supported' | 'thread-too-large';
};
export type SlackCorpusPage = { observations: SlackThreadObservation[]; nextCursor: string | null };
export type SlackThreadRead = SlackThreadObservation & { markdown: string };
export type SlackCorpusProvider = {
  discover(
    workspaceId: string,
    userId: string,
    kind: SlackCorpusKind,
    cursor?: string,
  ): Promise<{ binding: SlackCorpusBinding; items: SlackConversation[]; nextCursor: string | null }>;
  inspectSelection(
    workspaceId: string,
    userId: string,
    selection: SlackCorpusSelection,
  ): Promise<{ binding: SlackCorpusBinding; title: string; conversations: SlackConversation[] }>;
  access(
    workspaceId: string,
    userId: string,
    binding: SlackCorpusBinding,
    conversationId: string,
  ): Promise<SlackConversationAccess>;
  list(
    workspaceId: string,
    userId: string,
    binding: SlackCorpusBinding,
    conversationId: string,
    after: string,
    cursor: string | null,
  ): Promise<SlackCorpusPage>;
  read(
    workspaceId: string,
    userId: string,
    binding: SlackCorpusBinding,
    conversationId: string,
    ts: string,
    after: string,
  ): Promise<SlackThreadRead>;
};
export const slackHistoryScopes: Record<SlackConversationKind, readonly [string, string]> = {
  public: ['channels:history', 'channels:read'],
  private: ['groups:history', 'groups:read'],
  im: ['im:history', 'im:read'],
  mpim: ['mpim:history', 'mpim:read'],
};

/** `accountId` pins automatic requests to the Slack account (`team:user`) they were recorded for. */
export const slackKnowledgeConfigureSchema = z.strictObject({
  commandId: z.uuid(),
  selection: slackCorpusSelectionSchema,
  memberIds: z.array(z.uuid()).max(100),
  accountId: z.string().min(1).max(256).optional(),
});
export const slackKnowledgeManageSchema = z.strictObject({
  commandId: z.uuid(),
  action: z.enum(['pause', 'resume', 'retry', 'remove']),
});
export const slackKnowledgeWorkSchema = z.strictObject({
  workspaceId: z.uuid(),
  sourceId: z.uuid(),
  generation: z.number().int().positive(),
});
export const slackKnowledgeDiscoverSchema = z.strictObject({
  kind: slackCorpusKindSchema,
  cursor: slackCorpusCursorTokenSchema.optional(),
});
const conversationSchema = z.strictObject({
  conversationId: slackConversationIdSchema,
  kind: slackConversationKindSchema,
  title: z.string().max(512),
});
export const slackKnowledgeDiscoverySchema = z.strictObject({
  binding: slackCorpusBindingSchema,
  items: z.array(conversationSchema).max(1000),
  nextCursor: slackCorpusCursorTokenSchema.nullable(),
});
export const slackKnowledgeConversationSchema = conversationSchema.extend({
  state: z.enum(['active', 'unavailable']),
  failure: z.string().max(128).nullable(),
});
export const slackKnowledgeSourceSchema = z.strictObject({
  sourceId: z.uuid(),
  selection: slackCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()).max(101),
  title: z.string().max(2048),
  canManage: z.boolean(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().max(128).nullable(),
  nextAttemptAt: z.iso.datetime(),
  conversations: z.array(slackKnowledgeConversationSchema).max(slackCorpusLimits.conversations).nullable(),
  counts: z
    .strictObject({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type SlackKnowledgeConfigure = z.infer<typeof slackKnowledgeConfigureSchema>;
export type SlackKnowledgeManage = z.infer<typeof slackKnowledgeManageSchema>;
export type SlackKnowledgeWork = z.infer<typeof slackKnowledgeWorkSchema>;
export type SlackKnowledgeSource = z.infer<typeof slackKnowledgeSourceSchema>;
export const slackKnowledgeListSchema = z.strictObject({ items: z.array(slackKnowledgeSourceSchema).max(100) });
export const slackKnowledgeRefreshSchema = z.strictObject({
  refreshed: z.number().int().min(0).max(20),
  unavailable: z.number().int().min(0).max(20),
  bounded: z.literal(true),
});
export const slackKnowledgeEvidenceSchema = z.strictObject({
  title: z.string().max(512),
  text: z.string().max(32768),
  heading: z.string().max(2048),
  citation: knowledgeCitationSchema,
  original: z.strictObject({ kind: z.literal('slack') }),
  validUntil: z.iso.datetime(),
});
export const slackKnowledgeStatusSchema = z.strictObject({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string().max(512),
  publicationId: z.uuid().nullable(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  embedding: z.enum(['pending', 'failed', 'credits-blocked', 'ready']),
  failure: z.string().max(128).nullable(),
  historical: z.boolean(),
});
export const slackKnowledgeDocumentsQuerySchema = z.strictObject({ cursor: z.uuid().optional() });
export const slackKnowledgeDocumentsSchema = z.strictObject({
  items: z.array(slackKnowledgeStatusSchema.extend({ canRetry: z.boolean() })).max(20),
  nextCursor: z.uuid().nullable(),
});
