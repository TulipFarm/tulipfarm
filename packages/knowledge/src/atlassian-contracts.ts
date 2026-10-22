import { z } from 'zod';
import { knowledgeCitationSchema } from './contracts.ts';

export const atlassianCorpusLimits = Object.freeze({
  targets: 50,
  listPageSize: 25,
  accessBatch: 50,
  comments: 1000,
  commentPages: 10,
  markdownBytes: 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 10000,
  sweepBatch: 20,
});
export const atlassianProductSchema = z.enum(['confluence', 'jira']);
export const atlassianNumericIdSchema = z.string().regex(/^[1-9][0-9]{0,30}$/);
export const atlassianCursorTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
export const atlassianTargetKindSchema = z.enum(['space', 'page', 'project']);
export const atlassianTargetSchema = z.strictObject({
  kind: atlassianTargetKindSchema,
  id: atlassianNumericIdSchema,
  descendants: z.boolean(),
});
const productKinds: Record<z.infer<typeof atlassianProductSchema>, readonly string[]> = {
  confluence: ['space', 'page'],
  jira: ['project'],
};
export const atlassianTargetKey = (target: { kind: string; id: string }) => `${target.kind}:${target.id}`;
export const atlassianCorpusSelectionSchema = z
  .strictObject({
    product: atlassianProductSchema,
    cloudId: z.uuid(),
    targets: z
      .array(atlassianTargetSchema)
      .min(1)
      .max(atlassianCorpusLimits.targets)
      .refine(
        targets =>
          targets.every(
            (target, index) =>
              index === 0 || atlassianTargetKey(targets[index - 1] ?? target) < atlassianTargetKey(target),
          ),
        'Targets must be unique and sorted',
      )
      .refine(
        targets => targets.every(target => target.kind === 'page' || !target.descendants),
        'Only page targets can include child pages',
      ),
  })
  .refine(
    selection => selection.targets.every(target => productKinds[selection.product].includes(target.kind)),
    'Targets must belong to the selected product',
  );
export const atlassianCorpusBindingSchema = z.strictObject({
  accountId: z.uuid(),
  atlassianAccountId: z.string().min(1).max(256),
  cloudId: z.uuid(),
});
export const atlassianCorpusErrorCodeSchema = z.enum([
  'not-configured',
  'not-linked',
  'stale-integration',
  'reconnect-required',
  'insufficient-scope',
  'unauthenticated',
  'forbidden',
  'not-found',
  'outside-selection',
  'rate-limited',
  'transient',
  'invalid-response',
  'response-too-large',
  'invalid-cursor',
  'invalid-selection',
  'source-changed',
  'item-too-large',
]);
export type AtlassianCorpusErrorCode = z.infer<typeof atlassianCorpusErrorCodeSchema>;
export class AtlassianCorpusError extends Error {
  readonly code: AtlassianCorpusErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: AtlassianCorpusErrorCode, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'AtlassianCorpusError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
export type AtlassianProduct = z.infer<typeof atlassianProductSchema>;
export type AtlassianTargetKind = z.infer<typeof atlassianTargetKindSchema>;
export type AtlassianCorpusSelection = z.infer<typeof atlassianCorpusSelectionSchema>;
export type AtlassianCorpusBinding = z.infer<typeof atlassianCorpusBindingSchema>;
export type AtlassianSelectedTarget = z.infer<typeof atlassianTargetSchema> & { key: string | null };
export type AtlassianTarget = { kind: AtlassianTargetKind; id: string; key: string | null; title: string };
export type AtlassianSite = { cloudId: string; name: string; url: string };
/** Credential observation: the account generation that served the request and the time before the request was sent. */
export type AtlassianObservedAt = { accessedAt: string; accountGeneration: number };
export type AtlassianItemObservation = {
  nativeId: string;
  itemId: string;
  title: string;
  canonicalURL: string;
  sourceRevision: string;
  coverage: 'supported' | 'item-too-large';
};
export type AtlassianCorpusPage = AtlassianObservedAt & {
  observations: AtlassianItemObservation[];
  nextCursor: string | null;
};
export type AtlassianItemRead = AtlassianObservedAt & AtlassianItemObservation & { markdown: string };
export type AtlassianDiscoverKind = 'spaces' | 'pages' | 'projects';
export type AtlassianCorpusProvider = {
  /** `account` limits every account-resolving call to one connected Atlassian account; otherwise any eligible account is used. */
  sites(workspaceId: string, userId: string, options?: { account?: string }): Promise<{ items: AtlassianSite[] }>;
  discover(
    workspaceId: string,
    userId: string,
    cloudId: string,
    kind: AtlassianDiscoverKind,
    within?: string,
    cursor?: string,
    options?: { account?: string },
  ): Promise<{ binding: AtlassianCorpusBinding; items: AtlassianTarget[]; nextCursor: string | null }>;
  inspectSelection(
    workspaceId: string,
    userId: string,
    selection: AtlassianCorpusSelection,
    options?: { skipUnavailable?: boolean; account?: string },
  ): Promise<{ binding: AtlassianCorpusBinding; title: string; targets: AtlassianTarget[] }>;
  /** Authoritative batch check with the caller's own account. Returns only the item IDs that account can currently view. */
  access(
    workspaceId: string,
    userId: string,
    binding: AtlassianCorpusBinding,
    product: AtlassianProduct,
    itemIds: string[],
  ): Promise<AtlassianObservedAt & { visible: string[] }>;
  list(
    workspaceId: string,
    userId: string,
    binding: AtlassianCorpusBinding,
    target: AtlassianSelectedTarget,
    cursor: string | null,
  ): Promise<AtlassianCorpusPage>;
  read(
    workspaceId: string,
    userId: string,
    binding: AtlassianCorpusBinding,
    target: AtlassianSelectedTarget,
    itemId: string,
  ): Promise<AtlassianItemRead>;
};

/** `accountId` pins automatic requests to the Atlassian account they were recorded for. */
export const atlassianKnowledgeConfigureSchema = z.strictObject({
  commandId: z.uuid(),
  selection: atlassianCorpusSelectionSchema,
  memberIds: z.array(z.uuid()).max(100),
  accountId: z.uuid().optional(),
});
export const atlassianKnowledgeManageSchema = z.strictObject({
  commandId: z.uuid(),
  action: z.enum(['pause', 'resume', 'retry', 'remove']),
});
export const atlassianKnowledgeWorkSchema = z.strictObject({
  workspaceId: z.uuid(),
  sourceId: z.uuid(),
  generation: z.number().int().positive(),
});
export const atlassianKnowledgeDiscoverSchema = z.strictObject({
  cloudId: z.uuid(),
  kind: z.enum(['spaces', 'pages', 'projects']),
  within: atlassianNumericIdSchema.optional(),
  cursor: atlassianCursorTokenSchema.optional(),
});
const targetSchema = z.strictObject({
  kind: atlassianTargetKindSchema,
  id: atlassianNumericIdSchema,
  key: z.string().max(255).nullable(),
  title: z.string().max(512),
});
export const atlassianKnowledgeSitesSchema = z.strictObject({
  items: z.array(z.strictObject({ cloudId: z.uuid(), name: z.string().max(256), url: z.url().max(2048) })).max(256),
});
export const atlassianKnowledgeDiscoverySchema = z.strictObject({
  binding: atlassianCorpusBindingSchema,
  items: z.array(targetSchema).max(1000),
  nextCursor: atlassianCursorTokenSchema.nullable(),
});
export const atlassianKnowledgeTargetSchema = targetSchema.extend({
  descendants: z.boolean(),
  state: z.enum(['active', 'unavailable']),
  failure: z.string().max(128).nullable(),
});
export const atlassianKnowledgeSourceSchema = z.strictObject({
  sourceId: z.uuid(),
  product: atlassianProductSchema,
  selection: atlassianCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()).max(101),
  title: z.string().max(2048),
  canManage: z.boolean(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().max(128).nullable(),
  nextAttemptAt: z.iso.datetime(),
  targets: z.array(atlassianKnowledgeTargetSchema).max(atlassianCorpusLimits.targets).nullable(),
  counts: z
    .strictObject({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AtlassianKnowledgeConfigure = z.infer<typeof atlassianKnowledgeConfigureSchema>;
export type AtlassianKnowledgeManage = z.infer<typeof atlassianKnowledgeManageSchema>;
export type AtlassianKnowledgeWork = z.infer<typeof atlassianKnowledgeWorkSchema>;
export type AtlassianKnowledgeSource = z.infer<typeof atlassianKnowledgeSourceSchema>;
export const atlassianKnowledgeListSchema = z.strictObject({ items: z.array(atlassianKnowledgeSourceSchema).max(100) });
export const atlassianKnowledgeRefreshSchema = z.strictObject({
  refreshed: z.number().int().min(0).max(100),
  unavailable: z.number().int().min(0).max(100),
  bounded: z.literal(true),
});
export const atlassianKnowledgeEvidenceSchema = z.strictObject({
  title: z.string().max(512),
  text: z.string().max(32768),
  heading: z.string().max(2048),
  citation: knowledgeCitationSchema,
  original: z.strictObject({ kind: atlassianProductSchema }),
  validUntil: z.iso.datetime(),
});
export const atlassianKnowledgeStatusSchema = z.strictObject({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string().max(512),
  publicationId: z.uuid().nullable(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  embedding: z.enum(['pending', 'failed', 'credits-blocked', 'ready']),
  failure: z.string().max(128).nullable(),
  historical: z.boolean(),
});
export const atlassianKnowledgeDocumentsQuerySchema = z.strictObject({ cursor: z.uuid().optional() });
export const atlassianKnowledgeDocumentsSchema = z.strictObject({
  items: z.array(atlassianKnowledgeStatusSchema.extend({ canRetry: z.boolean() })).max(20),
  nextCursor: z.uuid().nullable(),
});
