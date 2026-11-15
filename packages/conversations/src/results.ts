import { z } from 'zod';
import { sourceDependencySchema, type SourceDependency } from '@tulipfarm/access';
import { modelFamilyIdSchema } from '@tulipfarm/config/model-identifier';
import { replyRenderInputSchema } from './layout-contracts.ts';
export {
  integrationSourceDependencySchema,
  sourceDependencySchema,
  sourceDependenciesSchema,
  type SourceDependency,
} from '@tulipfarm/access';
export const conversationResultSchema = z.strictObject({
  text: z.string().max(2097152),
  sources: z.array(sourceDependencySchema).max(1000),
  /** The configured fallback model family that answered after the chat model failed. */
  fallback: modelFamilyIdSchema.optional(),
  /** The reply's `reply.render` layout, checked by the responder. `text` is then its summary. */
  layout: replyRenderInputSchema.optional(),
  /** The model's layouts failed their checks; the reply is saved as one Text with a notice. */
  layoutFailed: z.literal(true).optional(),
});
export type ConversationResult = z.infer<typeof conversationResultSchema>;

export type ReviewCardReference = { kind: 'table' | 'row'; id: string };
export type ReviewCardState = { reference: ReviewCardReference; status: string; summary?: string };

export function reviewCardReference(tool: string, value: unknown): ReviewCardReference | undefined {
  if (!value || typeof value !== 'object' || 'error' in value) return undefined;
  const parsed = z
    .object({
      status: z.string(),
      id: z.string().min(1).optional(),
      draftId: z.string().min(1).optional(),
    })
    .safeParse(value);
  if (!parsed.success) return undefined;
  const receipt = parsed.data;
  if (tool === 'tables.propose' && receipt.status === 'pending' && receipt.id) return { kind: 'table', id: receipt.id };
  if (
    /^rows\.(?:create(?:\.batch)?|update|delete)$/.test(tool) &&
    receipt.status === 'review-required' &&
    receipt.draftId
  )
    return { kind: 'row', id: receipt.draftId };
  return undefined;
}

export function conversationResult(value: string | ConversationResult): ConversationResult {
  return conversationResultSchema.parse(
    typeof value === 'string' ? { text: value, sources: [{ kind: 'unknown' }] } : value,
  );
}

export function mergeSources(sources: readonly SourceDependency[]): SourceDependency[] {
  const unique = [...new Map(sources.map(source => [JSON.stringify(source), source])).values()];
  return unique.length <= 1000 ? unique : [{ kind: 'unknown' }];
}
