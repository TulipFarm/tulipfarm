import { z } from 'zod';
import { slackCorpusLimits } from './slack-contracts.ts';

export const defaultKnowledgeProducts = ['google-drive', 'gmail', 'slack', 'github', 'jira', 'confluence'] as const;
export const defaultKnowledgeProductSchema = z.enum(defaultKnowledgeProducts);
export type DefaultKnowledgeProduct = z.infer<typeof defaultKnowledgeProductSchema>;
export const defaultKnowledgeLimits = Object.freeze({
  pagesPerStep: 10,
  configuresPerStep: 10,
  scopes: 2000,
  rediscoverMs: 3_600_000,
  windowDays: 90,
  groups: { slack: slackCorpusLimits.conversations, atlassian: 50 },
});
export const defaultKnowledgeIntentInputSchema = z.strictObject({
  product: defaultKnowledgeProductSchema,
  membershipId: z.uuid(),
  accountKey: z.string().min(1).max(256),
  accountLabel: z.string().min(1).max(256),
});
export type DefaultKnowledgeIntentInput = z.infer<typeof defaultKnowledgeIntentInputSchema>;
export const defaultKnowledgeWorkSchema = z.strictObject({
  workspaceId: z.uuid(),
  intentId: z.uuid(),
  generation: z.number().int().positive(),
});
export type DefaultKnowledgeWork = z.infer<typeof defaultKnowledgeWorkSchema>;
export const defaultKnowledgeManageSchema = z.strictObject({ action: z.enum(['opt-out', 'resume', 'retry']) });
export const defaultKnowledgeCountsSchema = z.strictObject({
  total: z.number().int(),
  ready: z.number().int(),
  queued: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  quotaLimited: z.number().int(),
});
export const defaultKnowledgeIntentSchema = z.strictObject({
  intentId: z.uuid(),
  product: defaultKnowledgeProductSchema,
  accountKey: z.string(),
  accountLabel: z.string(),
  state: z.enum(['active', 'opted-out']),
  syncState: z.enum(['queued', 'discovering', 'ready', 'failed']),
  failure: z.string().nullable(),
  discoveredAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime(),
  scopes: z.strictObject({ discovered: z.number().int(), included: z.number().int(), manual: z.number().int() }),
  sources: z.array(
    z.strictObject({
      sourceId: z.uuid(),
      state: z.enum(['planned', 'created', 'failed']),
      failure: z.string().nullable(),
      sourceState: z.enum(['active', 'paused', 'disconnected', 'removed']).nullable(),
      /** The provider's own sync of a created source; null until it exists. */
      syncState: z.enum(['queued', 'syncing', 'ready', 'failed']).nullable(),
      syncFailure: z.string().nullable(),
    }),
  ),
  counts: defaultKnowledgeCountsSchema,
  /** Provider ingestion of the active created sources: pending until each finishes its first full pass; failed when any source-wide sync fails. Discovery being ready says nothing about this. */
  ingestion: z.strictObject({
    state: z.enum(['idle', 'pending', 'ready', 'failed']),
    pending: z.number().int(),
    failed: z.number().int(),
    failure: z.string().nullable(),
  }),
  /** Groups (Atlassian sites) skipped in the latest discovery pass because access was refused; other groups still sync. */
  groupFailures: z.array(z.strictObject({ title: z.string().max(256), failure: z.string().max(128) })).max(256),
});
export type DefaultKnowledgeIntent = z.infer<typeof defaultKnowledgeIntentSchema>;
export const defaultKnowledgeListSchema = z.strictObject({
  enabled: z.boolean(),
  items: z.array(defaultKnowledgeIntentSchema).max(100),
});
export type DefaultKnowledgeList = z.infer<typeof defaultKnowledgeListSchema>;
