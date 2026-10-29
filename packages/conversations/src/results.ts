import { z } from 'zod';
import { sourceDependencySchema, type SourceDependency } from '@tulipfarm/access';
import { avatarSnapshotSchema } from './avatar.ts';
import { modelFamilyIdSchema } from '@tulipfarm/config/model-identifier';
import { replyRenderInputSchema } from './layout-contracts.ts';
export {
  avatarStates,
  avatarStateSchema,
  avatarSnapshotSchema,
  bud,
  type AvatarState,
  type AvatarSnapshot,
} from './avatar.ts';
export {
  integrationSourceDependencySchema,
  sourceDependencySchema,
  sourceDependenciesSchema,
  type SourceDependency,
} from '@tulipfarm/access';
export const conversationResultSchema = z.strictObject({
  text: z.string().max(2097152),
  sources: z.array(sourceDependencySchema).max(1000),
  avatar: avatarSnapshotSchema.optional(),
  /** The configured fallback model family that answered after the chat model failed. */
  fallback: modelFamilyIdSchema.optional(),
  /** The reply's `reply.render` layout, checked by the responder. `text` is then its summary. */
  layout: replyRenderInputSchema.optional(),
  /** The model's layouts failed their checks; the reply is saved as one Text with a notice. */
  layoutFailed: z.literal(true).optional(),
});
export type ConversationResult = z.infer<typeof conversationResultSchema>;

export function conversationResult(value: string | ConversationResult): ConversationResult {
  return conversationResultSchema.parse(
    typeof value === 'string' ? { text: value, sources: [{ kind: 'unknown' }] } : value,
  );
}

export function mergeSources(sources: readonly SourceDependency[]): SourceDependency[] {
  const unique = [...new Map(sources.map(source => [JSON.stringify(source), source])).values()];
  return unique.length <= 1000 ? unique : [{ kind: 'unknown' }];
}
