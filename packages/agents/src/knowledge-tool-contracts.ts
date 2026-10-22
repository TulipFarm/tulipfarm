import { z } from 'zod';
import { knowledgeSourceDependencySchema } from '@tulipfarm/access/source-dependencies';

const kinds = z.enum(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']);
// The knowledge domain validates the exact format; the model schema stays small for provider quotas.
export const knowledgeCitationIdSchema = z.string();
const scope = {
  kind: kinds.optional(),
  sourceIds: z.array(z.uuid()).max(20).optional(),
  documentIds: z.array(z.uuid()).max(100).optional(),
};
const topicQuery = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe('One topic or document title, not a list of subjects. Use the shortest useful phrase.');
const branch = z
  .strictObject({
    query: topicQuery.optional(),
    reason: z.string().trim().min(1).max(512),
    citationIds: z.array(knowledgeCitationIdSchema).min(1).max(8).optional(),
    ...scope,
  })
  .refine(value => Boolean(value.query || value.citationIds?.length), 'A query or citation anchor is required');
export const knowledgeRetrieveInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('search'), query: topicQuery, ...scope }),
  z.strictObject({ action: z.literal('expand'), branches: z.array(branch).min(1).max(3) }),
]);
export const knowledgeToolCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('knowledge.search'), query: topicQuery, kind: kinds.optional() }),
  z.strictObject({ tool: z.literal('knowledge.read'), citationId: knowledgeCitationIdSchema }),
  z
    .strictObject({
      tool: z.literal('knowledge.retrieve'),
      action: z
        .enum(['search', 'expand'])
        .describe('Use search once for the initial topic. After that use expand, never search again.'),
      query: topicQuery.optional(),
      branches: z
        .array(branch)
        .min(1)
        .max(3)
        .describe('For expand only: submit one call containing one to three independent branches.')
        .optional(),
      ...scope,
    })
    .superRefine((value, ctx) => {
      const { tool: _tool, ...input } = value;
      if (!knowledgeRetrieveInputSchema.safeParse(input).success)
        ctx.addIssue({
          code: 'custom',
          message: 'Search needs a query; expansion needs one to three branches. Do not mix action fields.',
        });
    }),
]);
const hitSchema = z.strictObject({
  citationId: z.string().max(48),
  title: z.string(),
  heading: z.string(),
  excerpt: z.string().max(600),
  source: kinds,
});
const sources = z.array(knowledgeSourceDependencySchema).max(12);
const budget = z
  .strictObject({
    initialRemaining: z.number().int().min(0).max(1),
    deepRemaining: z.number().int().min(0).max(3),
    gapRemaining: z.number().int().min(0).max(3),
    stop: z.boolean(),
  })
  .optional();
export const knowledgeToolResultSchema = z.union([
  z.strictObject({
    provider: z.literal('knowledge'),
    mode: z.enum(['keyword-only', 'hybrid']),
    reason: z.string().nullable(),
    coverage: z.enum(['complete', 'partial', 'keyword-only']),
    hits: z.array(hitSchema).max(8),
    instruction: z.string(),
    sources,
    budget,
  }),
  z.strictObject({
    provider: z.literal('knowledge'),
    citationId: knowledgeCitationIdSchema,
    title: z.string(),
    heading: z.string(),
    source: kinds,
    text: z.string().max(4000),
    truncated: z.boolean(),
    instruction: z.string(),
    sources,
    budget,
  }),
  z.strictObject({
    provider: z.literal('knowledge'),
    citationId: knowledgeCitationIdSchema,
    error: z.literal('knowledge-unavailable'),
    instruction: z.string(),
    sources,
    budget,
  }),
  z.strictObject({
    provider: z.literal('knowledge'),
    error: z.literal('knowledge-unavailable'),
    instruction: z.string(),
    sources,
    budget,
  }),
  z.strictObject({
    provider: z.literal('knowledge'),
    action: z.enum(['search', 'expand']),
    instruction: z.string(),
    sources,
    branches: z
      .array(
        z.strictObject({
          index: z.number().int(),
          status: z.enum(['evidence', 'no-match', 'unavailable', 'failed']),
          mode: z.enum(['hybrid', 'keyword-only']).nullable(),
          reason: z.string().nullable(),
          coverage: z.enum(['complete', 'partial', 'keyword-only']).nullable(),
          queryBroadened: z.boolean().optional(),
          documents: z
            .array(
              z.strictObject({
                documentId: z.uuid(),
                publicationId: z.uuid(),
                title: z.string(),
                source: kinds,
                completeness: z.enum(['complete', 'partial']),
                omitted: z.boolean(),
                passages: z.array(
                  z.strictObject({
                    citationId: knowledgeCitationIdSchema,
                    heading: z.string(),
                    text: z.string(),
                    truncated: z.boolean(),
                  }),
                ),
              }),
            )
            .max(8),
        }),
      )
      .max(3),
    budget,
  }),
  z.strictObject({
    provider: z.literal('knowledge'),
    error: z.enum([
      'knowledge-action-required',
      'knowledge-budget-exhausted',
      'knowledge-round-pending',
      'knowledge-operation-spent',
      'knowledge-operation-conflict',
      'knowledge-recovery-required',
    ]),
    instruction: z.string(),
    sources,
    budget,
  }),
]);
export type KnowledgeToolCall = z.infer<typeof knowledgeToolCallSchema>;
export function knowledgeCallUsesQuery(call: KnowledgeToolCall) {
  return (
    call.tool === 'knowledge.search' ||
    (call.tool === 'knowledge.retrieve' &&
      (call.action === 'search' || call.branches?.some(branch => Boolean(branch.query)) === true))
  );
}
export type KnowledgeToolOutput = {
  result: Record<string, unknown>;
  sources: z.infer<typeof knowledgeSourceDependencySchema>[];
};
// Composed by the application with the knowledge domain. Calls use the server-resolved actor.
export type KnowledgeTools = {
  retrieve: (
    workspaceId: string,
    actor: { kind: 'human'; userId: string; membershipId: string },
    input: z.infer<typeof knowledgeRetrieveInputSchema>,
    context: KnowledgeCallContext,
  ) => Promise<KnowledgeToolOutput>;
  search: (
    workspaceId: string,
    actor: { kind: 'human'; userId: string; membershipId: string },
    input: Omit<Extract<KnowledgeToolCall, { tool: 'knowledge.search' }>, 'tool'>,
    context: { commandId: string; runId?: string; taskFlowId?: string; deadlineAt?: number; signal?: AbortSignal },
  ) => Promise<KnowledgeToolOutput>;
  read: (
    workspaceId: string,
    actor: { kind: 'human'; userId: string; membershipId: string },
    citationId: string,
    context?: { runId?: string; deadlineAt?: number; signal?: AbortSignal },
  ) => Promise<KnowledgeToolOutput>;
};
export type KnowledgeCallContext = {
  commandId: string;
  runId?: string;
  taskFlowId?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
  excludeCitationIds?: string[];
};
export const knowledgeToolsUnavailable = {
  provider: 'knowledge',
  error: 'knowledge-unavailable',
  instruction:
    'Knowledge search is not available in this environment. Tell the requester; do not invent knowledge evidence.',
} as const;
export function withKnowledgeRetrieveGrant<T extends string>(tools: readonly T[]): (T | 'knowledge.retrieve')[] {
  return tools.includes('knowledge.search' as T) &&
    tools.includes('knowledge.read' as T) &&
    !tools.includes('knowledge.retrieve' as T)
    ? [...tools, 'knowledge.retrieve']
    : [...tools];
}
