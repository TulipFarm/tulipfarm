import { z } from 'zod';

const uuid = z.uuid();
const validText = (value: string) =>
  !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const boundedText = z
  .string()
  .min(1)
  .max(10 * 1024 * 1024)
  .refine(value => validText(value) && new TextEncoder().encode(value).byteLength <= 10 * 1024 * 1024);
export const knowledgeSaveSchema = z.strictObject({
  commandId: uuid,
  documentId: uuid,
  expectedRevisionId: uuid.nullable(),
  title: z.string().trim().min(1).max(512).refine(validText),
  input: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('note'), text: boundedText }),
    z.strictObject({ kind: z.literal('file'), fileId: uuid }),
  ]),
});
export const knowledgeCommandSchema = z.strictObject({ commandId: uuid, documentId: uuid, expectedRevisionId: uuid });
export const knowledgeListSchema = z.strictObject({ cursor: uuid.optional() });
export const knowledgeSearchSchema = z.strictObject({ query: z.string().trim().min(1).max(512).refine(validText) });
export const knowledgeSearchFiltersSchema = z.strictObject({
  kinds: z
    .array(z.enum(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']))
    .max(8)
    .default(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']),
  sourceIds: z.array(uuid).max(20).default([]),
  documentIds: z.array(uuid).max(100).default([]),
});
const searchFields = {
  query: knowledgeSearchSchema.shape.query,
  filters: knowledgeSearchFiltersSchema.default({
    kinds: ['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation'],
    sourceIds: [],
    documentIds: [],
  }),
};
export const knowledgeSearchRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('typing'), ...searchFields }),
  z.strictObject({
    kind: z.literal('submitted'),
    commandId: uuid,
    retrySemantic: z.boolean().default(false),
    ...searchFields,
  }),
  z.strictObject({
    kind: z.literal('continue'),
    continuation: z
      .string()
      .max(128)
      .regex(/^[a-f0-9-]{36}:[0-9]{1,3}$/),
  }),
]);
export const knowledgeCitationSchema = z.strictObject({
  kind: z.literal('knowledge-document'),
  workspaceId: uuid,
  sourceId: uuid,
  documentId: uuid,
  revisionId: uuid,
  publicationId: uuid,
  accessEpoch: z.number().int().positive(),
  ordinal: z.number().int().min(0).max(4095),
});
const documentBase = z.object({
  documentId: uuid,
  revisionId: uuid,
  title: z.string(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  failure: z.string().nullable(),
  publicationId: uuid.nullable(),
  canRetry: z.boolean(),
});
export const knowledgeDocumentSchema = z.discriminatedUnion('kind', [
  documentBase.extend({ kind: z.literal('note'), noteText: z.string().optional() }),
  documentBase.extend({ kind: z.literal('file'), fileId: uuid }),
]);
export const knowledgeHitSchema = z.object({
  title: z.string(),
  text: z.string(),
  heading: z.string(),
  citation: knowledgeCitationSchema,
});
export const knowledgeSearchReasonSchema = z.enum([
  'semantic-not-enabled',
  'typing',
  'no-semantic-content',
  'embedding-pending',
  'credits-blocked',
  'capacity-blocked',
  'provider-unavailable',
  'deadline',
]);
export const knowledgeSearchResultSchema = z.object({
  mode: z.enum(['keyword-only', 'hybrid']),
  reason: knowledgeSearchReasonSchema.nullable(),
  queryBroadened: z.boolean().optional(),
  hits: z.array(knowledgeHitSchema),
  validUntil: z.iso.datetime(),
  continuation: z.string().nullable().default(null),
  coverage: z.enum(['complete', 'partial', 'keyword-only']).default('keyword-only'),
  bounded: z.boolean().default(true),
});
export type KnowledgeSearchFilters = z.infer<typeof knowledgeSearchFiltersSchema>;
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;
export const knowledgeEvidenceSchema = knowledgeHitSchema.extend({
  original: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('note') }),
    z.object({ kind: z.literal('file'), fileId: uuid }),
    z.object({ kind: z.literal('google') }),
    z.object({ kind: z.literal('slack') }),
    z.object({ kind: z.literal('github') }),
    z.object({ kind: z.literal('confluence') }),
    z.object({ kind: z.literal('jira') }),
    z.object({ kind: z.literal('conversation'), conversationId: uuid }),
  ]),
  validUntil: z.iso.datetime(),
});
export const knowledgeWorkSchema = z.strictObject({
  workspaceId: uuid,
  revisionId: uuid,
  generation: z.number().int().positive(),
});
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeWork = z.infer<typeof knowledgeWorkSchema>;
export type KnowledgeSave = z.infer<typeof knowledgeSaveSchema>;
export type KnowledgeCommand = z.infer<typeof knowledgeCommandSchema>;
