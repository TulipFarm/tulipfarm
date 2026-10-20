import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access';

export const embeddingWorkSchema = z.strictObject({
  workspaceId: uuidSchema,
  jobId: uuidSchema,
  generation: z.number().int().positive().optional(),
});
export const embeddingQuerySchema = z.strictObject({ commandId: uuidSchema, query: z.string().min(1).max(131072) });
export const embeddingRetrySchema = z.strictObject({
  commandId: uuidSchema,
  expectedGeneration: z.number().int().positive(),
});
export const embeddingDocumentRetrySchema = embeddingRetrySchema.extend({ expectedJobId: uuidSchema });
export const embeddingStateSchema = z.enum([
  'queued',
  'busy',
  'ready',
  'disabled',
  'credits-blocked',
  'capacity-blocked',
  'failed',
  'unknown',
  'invalid-input',
]);
const statusFields = {
  jobId: uuidSchema,
  generation: z.number().int().positive(),
  profileId: z.string(),
  state: embeddingStateSchema,
  canRetry: z.boolean(),
};
export const embeddingQueryStatusSchema = z.object({
  ...statusFields,
  commandId: uuidSchema,
  vector: z.array(z.number().finite()).length(1536).nullable(),
});
export const embeddingDocumentStatusSchema = z.object({
  ...statusFields,
  documentId: uuidSchema,
  revisionId: uuidSchema,
  publicationId: uuidSchema,
  completedChunks: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
});
export type EmbeddingWork = z.infer<typeof embeddingWorkSchema>;
export type EmbeddingQueryStatus = z.infer<typeof embeddingQueryStatusSchema>;
export type EmbeddingDocumentStatus = z.infer<typeof embeddingDocumentStatusSchema>;
export type EmbeddingState = z.infer<typeof embeddingStateSchema>;
export type { KnowledgeEmbeddingsOptions, KnowledgeEmbeddingCapacity } from './internal/embeddings.ts';
export type { KnowledgeEmbeddingProvider, KnowledgeEmbeddingResult } from './internal/embedding-provider.ts';
