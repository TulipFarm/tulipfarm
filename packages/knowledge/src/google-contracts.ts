import { z } from 'zod';
import {
  googleCorpusSelectionSchema,
  googleCorpusKindSchema,
  googleCorpusPageTokenSchema,
  googleCorpusBindingSchema,
  googleCorpusIdSchema,
} from '@tulipfarm/google-workspace/corpus-contracts';
import { knowledgeCitationSchema } from './contracts.ts';
export { googleCorpusSelectionSchema, googleCorpusKindSchema };
/** `accountId` pins automatic requests to the Google account they were recorded for. */
export const googleKnowledgeConfigureSchema = z.strictObject({
  commandId: z.uuid(),
  selection: googleCorpusSelectionSchema,
  memberIds: z.array(z.uuid()).max(100),
  accountId: z.string().min(1).max(255).optional(),
});
export const googleKnowledgeManageSchema = z.strictObject({
  commandId: z.uuid(),
  action: z.enum(['pause', 'resume', 'retry', 'remove']),
});
export const googleKnowledgeWorkSchema = z.strictObject({
  workspaceId: z.uuid(),
  sourceId: z.uuid(),
  generation: z.number().int().positive(),
});
export const googleKnowledgeDiscoverSchema = z.strictObject({
  kind: googleCorpusKindSchema,
  cursor: googleCorpusPageTokenSchema.optional(),
});
export const googleKnowledgeDiscoverySchema = z.strictObject({
  binding: googleCorpusBindingSchema,
  items: z
    .array(
      z.strictObject({ nativeId: googleCorpusIdSchema, title: z.string().max(2048), kind: googleCorpusKindSchema }),
    )
    .max(10000),
  nextCursor: googleCorpusPageTokenSchema.nullable(),
});
export const googleKnowledgeSourceSchema = z.strictObject({
  sourceId: z.uuid(),
  selection: googleCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()).max(101),
  title: z.string().max(2048),
  canManage: z.boolean(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().max(128).nullable(),
  nextAttemptAt: z.iso.datetime(),
  counts: z
    .strictObject({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type GoogleKnowledgeConfigure = z.infer<typeof googleKnowledgeConfigureSchema>;
export type GoogleKnowledgeManage = z.infer<typeof googleKnowledgeManageSchema>;
export type GoogleKnowledgeWork = z.infer<typeof googleKnowledgeWorkSchema>;
export type GoogleKnowledgeSource = z.infer<typeof googleKnowledgeSourceSchema>;
export const googleKnowledgeListSchema = z.strictObject({ items: z.array(googleKnowledgeSourceSchema).max(100) });
export const googleKnowledgeRefreshSchema = z.strictObject({
  refreshed: z.number().int().min(0).max(20),
  unavailable: z.number().int().min(0).max(20),
  bounded: z.literal(true),
});
export const googleKnowledgeEvidenceSchema = z.strictObject({
  title: z.string().max(512),
  text: z.string().max(32768),
  heading: z.string().max(2048),
  citation: knowledgeCitationSchema,
  original: z.strictObject({ kind: z.literal('google') }),
  validUntil: z.iso.datetime(),
});
export const googleKnowledgeStatusSchema = z.strictObject({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string().max(512),
  publicationId: z.uuid().nullable(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  embedding: z.enum(['pending', 'failed', 'credits-blocked', 'ready']),
  failure: z.string().max(128).nullable(),
});
export const googleKnowledgeDocumentsQuerySchema = z.strictObject({ cursor: z.uuid().optional() });
export const googleKnowledgeDocumentsSchema = z.strictObject({
  items: z.array(googleKnowledgeStatusSchema.extend({ canRetry: z.boolean() })).max(20),
  nextCursor: z.uuid().nullable(),
});
