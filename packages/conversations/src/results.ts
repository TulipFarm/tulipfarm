import { z } from 'zod';
import { sourceDependencySchema, type SourceDependency } from '@tulipfarm/access';
import { chatTitleSchema } from './contracts.ts';
import { avatarSnapshotSchema } from './avatar.ts';
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
  title: chatTitleSchema.optional(),
  titleSource: z.literal('user-message').optional(),
  sources: z.array(sourceDependencySchema).max(1000),
  avatar: avatarSnapshotSchema.optional(),
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
