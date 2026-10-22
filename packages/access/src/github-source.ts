import { escapeIdentifier } from 'pg';
import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from './index.ts';
import type { SourceDependency } from './source-dependencies.ts';
import { requireGitHubTask } from './github-task.ts';

const table = (tx: AuthorizationTransaction, name: string) =>
  `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;

export async function requireOrdinaryGitHubChat(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
) {
  await currentMember(tx, actor);
  const allowed = await tx.client.query(
    `SELECT c.id FROM ${table(tx, 'tf_conversations')} c WHERE c.id=$1 AND c.kind='private' AND c.owner_user_id=$2 AND c.owner_membership_id=$3
    AND c.deleted_at IS NULL AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_projects')} p JOIN ${table(tx, 'tf_project_members')} m ON m.project_id=p.id WHERE p.id=c.project_id AND p.archived_at IS NULL AND m.membership_id=$3 AND m.removed_at IS NULL))
    AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_dm_roots')} s WHERE s.conversation_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} s WHERE s.conversation_id=c.id) FOR UPDATE`,
    [conversationId, actor.userId, actor.membershipId],
  );
  if (!allowed.rowCount) throw new AccessDenied();
}
export async function requirePersonalGitHubSelection(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  source: Extract<SourceDependency, { kind: 'github-personal' }>,
) {
  if (actor.membershipId !== source.membershipId) throw new AccessDenied();
  if (source.origin === 'task') {
    await requireGitHubTask(tx, actor, source.taskId);
    const allowed = await tx.client.query(
      `SELECT a.id FROM ${table(tx, 'tf_github_accounts')} a JOIN ${table(tx, 'tf_github_task_selection')} s ON s.account_id=a.id WHERE a.id=$1 AND a.owner_membership_id=$2 AND a.generation=$3 AND a.state='active' AND a.credential IS NOT NULL AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()) AND s.task_id=$4 AND s.account_generation=a.generation AND s.version=$5 FOR UPDATE OF a FOR SHARE OF s`,
      [source.accountId, source.membershipId, source.generation, source.taskId, source.selectionVersion],
    );
    if (!allowed.rowCount) throw new AccessDenied();
    return;
  }
  await requireOrdinaryGitHubChat(tx, actor, source.conversationId);
  const allowed = await tx.client.query(
    `SELECT a.id FROM ${table(tx, 'tf_github_accounts')} a JOIN ${table(tx, 'tf_github_chat_selection')} s ON s.account_id=a.id
    WHERE a.id=$1 AND a.owner_membership_id=$2 AND a.generation=$3 AND a.state='active' AND a.credential IS NOT NULL
    AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()) AND s.conversation_id=$4 AND s.account_generation=a.generation AND s.version=$5 FOR UPDATE OF a FOR SHARE OF s`,
    [source.accountId, source.membershipId, source.generation, source.conversationId, source.selectionVersion],
  );
  if (!allowed.rowCount) throw new AccessDenied();
}

export async function requirePersonalGitHubSource(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  source: Extract<SourceDependency, { kind: 'github-personal' }>,
) {
  await requirePersonalGitHubSelection(tx, actor, source);
  if ((!source.proof && !(source.origin === 'task' && source.batchId)) || !tx.requireGitHubSource)
    throw new AccessDenied();
  await tx.requireGitHubSource(actor, source);
}
