import { z } from 'zod';

const branchStatus = z.enum(['evidence', 'no-match', 'unavailable', 'failed']);
export const knowledgeActivitySchema = z.object({
  action: z.enum(['search', 'expand']).nullable(),
  status: z.enum(['running', 'success', 'partial', 'empty', 'unavailable', 'failed', 'exhausted', 'waiting']),
  branches: z
    .array(
      z.object({
        index: z.number().int().min(0).max(2),
        status: branchStatus,
        reason: z.string().nullable(),
        documents: z
          .array(
            z.object({ title: z.string().max(512), passages: z.number().int().min(0).max(32), partial: z.boolean() }),
          )
          .max(8),
      }),
    )
    .max(3),
});
export type KnowledgeActivity = z.infer<typeof knowledgeActivitySchema>;
const resultSchema = z.object({
  result: z.object({
    provider: z.literal('knowledge'),
    action: z.enum(['search', 'expand']),
    branches: z
      .array(
        z.object({
          index: z.number().int().min(0).max(2),
          status: branchStatus,
          reason: z.string().nullable(),
          documents: z
            .array(
              z.object({
                title: z.string().max(512),
                completeness: z.enum(['complete', 'partial']),
                omitted: z.boolean(),
                passages: z.array(z.object({ truncated: z.boolean() })).max(32),
              }),
            )
            .max(8),
        }),
      )
      .min(1)
      .max(3),
  }),
});
const failureSchema = z.object({ result: z.object({ provider: z.literal('knowledge'), error: z.string() }) });

export function knowledgeActivity(
  tool: string,
  call: unknown,
  output: unknown,
  status: string,
): KnowledgeActivity | null {
  if (tool !== 'knowledge.retrieve') return null;
  const input = z.object({ action: z.enum(['search', 'expand']) }).safeParse(call);
  const action = input.success ? input.data.action : null;
  if (output == null && status === 'running') return { action, status: 'running', branches: [] };
  const failure = failureSchema.safeParse(output);
  if (failure.success) {
    const error = failure.data.result.error;
    return {
      action,
      status:
        error === 'knowledge-budget-exhausted'
          ? 'exhausted'
          : error === 'knowledge-round-pending'
            ? 'waiting'
            : error === 'knowledge-unavailable'
              ? 'unavailable'
              : 'failed',
      branches: [],
    };
  }
  const parsed = resultSchema.safeParse(output);
  if (!parsed.success) return { action, status: 'failed', branches: [] };
  const branches = parsed.data.result.branches.map(branch => ({
    index: branch.index,
    status: branch.status,
    reason: branch.reason,
    documents: branch.documents.map(document => ({
      title: document.title,
      passages: document.passages.length,
      partial:
        document.omitted || document.completeness === 'partial' || document.passages.some(passage => passage.truncated),
    })),
  }));
  const evidence = branches.some(branch => branch.documents.some(document => document.passages > 0));
  const incomplete = branches.some(
    branch =>
      branch.status === 'failed' ||
      branch.status === 'unavailable' ||
      branch.documents.some(document => document.partial),
  );
  return {
    action: parsed.data.result.action,
    branches,
    status: evidence
      ? incomplete
        ? 'partial'
        : 'success'
      : branches.some(branch => branch.status === 'failed')
        ? 'failed'
        : branches.some(branch => branch.status === 'unavailable')
          ? 'unavailable'
          : 'empty',
  };
}
