import { z } from 'zod';
import { AccessDenied, uuidSchema, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { ConversationConflict } from './contracts.ts';
import { requireProjectAccess } from './project-membership.ts';

export type ChatAccessRule = 'read' | 'turn' | 'manage';
const chatOwnerSchema = z.object({ owner: z.boolean(), projectId: uuidSchema.nullable() });

export async function authorizeChat(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  chat: z.infer<typeof chatOwnerSchema>,
  rule: ChatAccessRule,
) {
  if (!chat.projectId) {
    if (!chat.owner) throw new AccessDenied();
    return;
  }
  const project = await requireProjectAccess(tx, actor, chat.projectId, rule === 'manage' && !chat.owner);
  if (rule !== 'read' && project.archived) throw new ConversationConflict('project-archived');
}

export async function chatAccess(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  chatId: string,
  rule: ChatAccessRule = 'read',
  lock = false,
) {
  const chat = chatOwnerSchema.optional().parse(
    (
      await tx.client.query(
        `SELECT (owner_user_id=$2 AND owner_membership_id=$3) AS owner, project_id AS "projectId"
    FROM ${qualified(tx.schema, 'tf_conversations')} WHERE id=$1 AND kind='private' AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
        [chatId, actor.userId, actor.membershipId],
      )
    ).rows[0],
  );
  if (!chat) throw new AccessDenied();
  await authorizeChat(tx, actor, chat, rule);
  return chat;
}
