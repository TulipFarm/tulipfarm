import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, uuidSchema } from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { chatTitleSchema, defaultConversationModel } from './contracts.ts';
import { notifyConversationChange } from './event-publisher.ts';
import { replyWorkSchema, type ConversationRuntime } from './runtime.ts';

type RuntimeTransaction = Parameters<Parameters<ConversationRuntime['transaction']>[2]>[0];
export const conversationTitleWorkSchema = replyWorkSchema.extend({ titleRevision: z.number().int().nonnegative() });
export type ConversationTitleWork = z.infer<typeof conversationTitleWorkSchema>;

const chatSchema = z.object({
  owner_user_id: z.string(),
  owner_membership_id: uuidSchema,
  title_manual: z.boolean(),
  title_revision: z.number().int(),
  responder: z.string(),
  text: z.string(),
});

/**
 * The first reply's generated title, applied after that reply was delivered. Each step is one short transaction,
 * so no transaction is held across the model call, and a title the user set in the meantime always wins.
 */
export function createConversationTitles(runtime: ConversationRuntime) {
  const transaction = <T>(workspaceId: string, operation: (tx: RuntimeTransaction) => Promise<T>) =>
    runtime.transaction(workspaceId, { minimum: 1, maximum: commonCompatibility.maximum }, async tx => {
      await lockAuthorization(tx, 'read');
      return operation(tx);
    });

  /** The requester's first message and the chat's model, or null when the chat no longer needs this title. */
  async function request(value: unknown): Promise<{ text: string; model: string } | null> {
    const work = conversationTitleWorkSchema.parse(value);
    return transaction(work.workspaceId, async tx => {
      const table = (name: string) => qualified(tx.schema, name);
      const chat = chatSchema.optional().parse(
        (
          await tx.client.query(
            `SELECT c.owner_user_id, c.owner_membership_id, c.title_manual, c.title_revision, t.responder,
              COALESCE((SELECT string_agg(p.text, '' ORDER BY p.ordinal) FROM ${table('tf_conversation_parts')} p WHERE p.message_id = t.source_message_id AND p.kind = 'text'), '') AS text
            FROM ${table('tf_conversations')} c JOIN ${table('tf_conversation_turns')} t ON t.conversation_id = c.id
            WHERE c.id = $1 AND c.kind = 'private' AND t.id = $2 AND t.generation = $3 AND t.status = 'completed' AND t.accepted_sequence = 1`,
            [work.conversationId, work.turnId, work.generation],
          )
        ).rows[0],
      );
      if (!chat || chat.title_manual || chat.title_revision !== work.titleRevision || !chat.text.trim()) return null;
      try {
        await currentMember(tx, { kind: 'human', userId: chat.owner_user_id, membershipId: chat.owner_membership_id });
      } catch (error) {
        if (error instanceof AccessDenied) return null;
        throw error;
      }
      return {
        text: chat.text,
        model: chat.responder === 'reverse-text-v1' ? defaultConversationModel : chat.responder,
      };
    });
  }

  /** Saves the title unless the user renamed the chat or another title landed first, then tells listeners. */
  async function save(value: unknown, title: string): Promise<'generated' | 'skipped'> {
    const work = conversationTitleWorkSchema.parse(value);
    const parsed = chatTitleSchema.parse(title);
    return transaction(work.workspaceId, async tx => {
      const updated = await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_conversations')} SET title = $2, title_revision = title_revision + 1 WHERE id = $1 AND kind = 'private' AND NOT title_manual AND title_revision = $3`,
        [work.conversationId, parsed, work.titleRevision],
      );
      if (!updated.rowCount) return 'skipped';
      await notifyConversationChange(tx, { workspaceId: work.workspaceId, conversationId: work.conversationId });
      return 'generated';
    });
  }

  return { request, save };
}
