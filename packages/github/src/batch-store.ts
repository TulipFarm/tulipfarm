import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requirePersonalGitHubSelection,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { AccountRuntime } from './accounts.ts';
import {
  actionOutcomeSchema,
  batchSnapshotSchema,
  batchViewSchema,
  GitHubBatchError,
  type BatchSnapshot,
} from './batch-contracts.ts';
import { batchDigest } from './write-provider.ts';
import { requireGitHubTaskExecution } from '@tulipfarm/access';
import { contextColumn, contextId, requireGitHubOrigin, type GitHubContext } from './origin.ts';
import { githubSelection } from './selection.ts';

export const batchRange = commonCompatibility;
export const batchTable = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_github_${name}`);
export const rowSchema = z.object({ snapshot: batchSnapshotSchema, digest: z.string(), expired: z.boolean() });
export const snapshotContext = (snapshot: BatchSnapshot): GitHubContext =>
  snapshot.origin.kind === 'chat' ? snapshot.origin.conversationId : { taskId: snapshot.origin.taskId };
export const selectionSource = (snapshot: BatchSnapshot) => ({
  kind: 'github-personal' as const,
  accountId: snapshot.accountId,
  membershipId: snapshot.membershipId,
  generation: snapshot.generation,
  selectionVersion: snapshot.selectionVersion,
  ...(snapshot.origin.kind === 'chat'
    ? { conversationId: snapshot.origin.conversationId }
    : { origin: 'task' as const, taskId: snapshot.origin.taskId, taskGeneration: snapshot.origin.generation }),
});
export async function batchLock(tx: AuthorizationTransaction, id: string) {
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`github-batch:${id}`]);
}
export function batchAccess(runtime: AccountRuntime) {
  return async <T>(
    workspaceId: string,
    principal: string | HumanActor,
    context: GitHubContext,
    action: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) =>
    runtime.transaction(z.uuid().parse(workspaceId), batchRange, async tx => {
      await lockAuthorization(tx);
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      await currentMember(tx, actor);
      await requireGitHubOrigin(tx, actor, context);
      if ((await githubSelection(tx, context)).investigation) throw new AccessDenied();
      return action(tx, actor);
    });
}
export async function loadBatch(tx: AuthorizationTransaction, actor: HumanActor, context: GitHubContext, id: string) {
  const row = rowSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT snapshot,digest,expires_at<=clock_timestamp() AS expired FROM ${batchTable(tx, 'batches')} WHERE id=$1 AND membership_id=$2 AND ${contextColumn(context)}=$3`,
          [z.uuid().parse(id), actor.membershipId, contextId(context)],
        )
      ).rows[0],
    );
  if (!row || batchDigest(row.snapshot) !== row.digest) throw new AccessDenied();
  return row;
}
export async function batchView(tx: AuthorizationTransaction, row: z.infer<typeof rowSchema>) {
  const decision = z
    .enum(['approve', 'reject'])
    .nullable()
    .parse(
      (
        await tx.client.query(`SELECT decision FROM ${batchTable(tx, 'batch_decisions')} WHERE batch_id=$1`, [
          row.snapshot.id,
        ])
      ).rows[0]?.decision ?? null,
    );
  const receipts = z
    .array(actionOutcomeSchema)
    .parse(
      (
        await tx.client.query(
          `SELECT ordinal,status,result,reconciliation FROM ${batchTable(tx, 'action_receipts')} WHERE batch_id=$1 ORDER BY ordinal`,
          [row.snapshot.id],
        )
      ).rows,
    );
  return batchViewSchema.parse({
    ...row,
    decision,
    actions: row.snapshot.actions.map(
      (_, ordinal) =>
        receipts.find(receipt => receipt.ordinal === ordinal) ?? {
          ordinal,
          status: 'unattempted',
          result: null,
          reconciliation: null,
        },
    ),
  });
}
export async function freshBatch(tx: AuthorizationTransaction, actor: HumanActor, row: z.infer<typeof rowSchema>) {
  if ((await githubSelection(tx, snapshotContext(row.snapshot))).investigation) throw new AccessDenied();
  if (row.expired) throw new GitHubBatchError('batch-expired');
  await requirePersonalGitHubSelection(tx, actor, selectionSource(row.snapshot));
  if (row.snapshot.origin.kind === 'task') {
    await requireGitHubTaskExecution(
      tx,
      actor,
      row.snapshot.origin.taskId,
      row.snapshot.origin.generation,
      'github.personal.propose',
    );
    return;
  }
  const turn = await tx.client.query(
    `SELECT id FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND status IN ('processing','completed') FOR SHARE`,
    [row.snapshot.origin.turnId, row.snapshot.origin.conversationId, row.snapshot.origin.generation],
  );
  if (!turn.rowCount) throw new GitHubBatchError('batch-conflict');
}
export async function selectOnlyAccount(tx: AuthorizationTransaction, actor: HumanActor, conversationId: string) {
  const accounts = await tx.client.query(
    `SELECT id,generation FROM ${batchTable(tx, 'accounts')} WHERE owner_membership_id=$1 AND state='active' AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 2 FOR SHARE`,
    [actor.membershipId],
  );
  const only =
    accounts.rows.length === 1 ? z.object({ id: z.uuid(), generation: z.number() }).parse(accounts.rows[0]) : null;
  if (only)
    await tx.client.query(
      `INSERT INTO ${batchTable(tx, 'chat_selection')} (conversation_id,account_id,account_generation,version,context_start) VALUES ($1,$2,$3,1,1) ON CONFLICT (conversation_id) DO NOTHING`,
      [conversationId, only.id, only.generation],
    );
}
