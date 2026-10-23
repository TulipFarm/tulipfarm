import { z } from 'zod';
import { knowledgeFreshnessSchema, knowledgeSearchFiltersSchema } from './knowledge.ts';

export const knowledgeRetrievalLimits = Object.freeze({
  initialDocuments: 8,
  initialCharacters: 16_000,
  branches: 3,
  branchDocuments: 4,
  branchCharacters: 8_000,
  passagesPerDocument: 32,
  resultCharacters: 64_000,
});
const citationId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,3})$/);
const provider = knowledgeSearchFiltersSchema.shape.kinds.unwrap().element;
const scope = {
  kind: provider.optional(),
  sourceIds: z.array(z.uuid()).max(20).optional(),
  documentIds: z.array(z.uuid()).max(100).optional(),
};
export const knowledgeRetrievalBranchSchema = z
  .strictObject({
    query: z.string().trim().min(1).max(512).optional(),
    reason: z.string().trim().min(1).max(512),
    citationIds: z.array(citationId).min(1).max(8).optional(),
    ...scope,
  })
  .refine(branch => Boolean(branch.query || branch.citationIds?.length), {
    message: 'A branch requires a query or citation anchors.',
  });
export const knowledgeRetrieveInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('search'), query: z.string().trim().min(1).max(512), ...scope }),
  z.strictObject({
    action: z.literal('expand'),
    branches: z.array(knowledgeRetrievalBranchSchema).min(1).max(knowledgeRetrievalLimits.branches),
  }),
]);
export const knowledgeRetrievalDocumentSchema = z.strictObject({
  documentId: z.uuid(),
  publicationId: z.uuid(),
  title: z.string().max(512),
  source: provider,
  completeness: z.enum(['complete', 'partial']),
  omitted: z.boolean(),
  indexedAt: knowledgeFreshnessSchema.shape.indexedAt,
  sourceRevision: knowledgeFreshnessSchema.shape.sourceRevision,
  sourceSyncedAt: knowledgeFreshnessSchema.shape.sourceSyncedAt,
  passages: z
    .array(
      z.strictObject({
        citationId,
        heading: z.string().max(2048),
        text: z.string().max(knowledgeRetrievalLimits.initialCharacters),
        truncated: z.boolean(),
      }),
    )
    .max(knowledgeRetrievalLimits.passagesPerDocument),
});
export const knowledgeRetrievalBranchResultSchema = z.strictObject({
  index: z.number().int().min(0).max(2),
  status: z.enum(['evidence', 'no-match', 'unavailable', 'failed']),
  mode: z.enum(['hybrid', 'keyword-only']).nullable(),
  queryBroadened: z.boolean().optional(),
  reason: z.string().nullable(),
  coverage: z.enum(['complete', 'partial', 'keyword-only']).nullable(),
  documents: z.array(knowledgeRetrievalDocumentSchema).max(knowledgeRetrievalLimits.initialDocuments),
});
export const knowledgeRetrieveResultSchema = z.strictObject({
  provider: z.literal('knowledge'),
  action: z.enum(['search', 'expand']),
  branches: z.array(knowledgeRetrievalBranchResultSchema).min(1).max(knowledgeRetrievalLimits.branches),
  instruction: z.string(),
});
export type KnowledgeRetrieveInput = z.infer<typeof knowledgeRetrieveInputSchema>;
export type KnowledgeRetrievalBranch = z.infer<typeof knowledgeRetrievalBranchSchema>;
export type KnowledgeRetrievalDocument = z.infer<typeof knowledgeRetrievalDocumentSchema>;
export type KnowledgeRetrievalBranchResult = z.infer<typeof knowledgeRetrievalBranchResultSchema>;
