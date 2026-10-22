import { currentMember, lockAuthorization } from '@tulipfarm/access';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { batchDecisionSchema, GitHubBatchError, type BatchView } from './batch-contracts.ts';
import { batchAccess, batchTable, batchView, loadBatch } from './batch-store.ts';
import { createGitHubBatches, type BatchOptions } from './batches.ts';
import { requireGitHubOrigin, contextColumn, contextId, selectionTable, type GitHubContext } from './origin.ts';

export function createGitHubBatchDecision(
  options: BatchOptions & { resolveConfirmationCredential: (workspaceId: string) => Promise<string> },
) {
  const service = createGitHubBatches(options);
  const access = batchAccess(options.runtime);
  return async (
    workspaceId: string,
    userId: string,
    conversationId: GitHubContext,
    id: string,
    input: unknown,
  ): Promise<BatchView> => {
    const decision = batchDecisionSchema.parse(input);
    await service.read(workspaceId, userId, conversationId, id);
    const actor = await access(workspaceId, userId, conversationId, async (_tx, actor) => actor);
    return withMaintenanceTransaction({
      connectionString: await options.resolveConfirmationCredential(workspaceId),
      workspaceId,
      capability: 'confirmation',
      operation: async tx => {
        await lockAuthorization(tx);
        await currentMember(tx, actor);
        await requireGitHubOrigin(tx, actor, conversationId);
        const row = await loadBatch(tx, actor, conversationId, id);
        if (row.expired || decision.digest !== row.digest) throw new GitHubBatchError('batch-conflict');
        const selected = await tx.client.query(
          `SELECT a.id FROM ${batchTable(tx, 'accounts')} a JOIN ${qualified(tx.schema, selectionTable(conversationId))} s ON s.account_id=a.id WHERE a.id=$1 AND a.owner_membership_id=$2 AND a.generation=$3 AND a.state='active' AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()) AND s.${contextColumn(conversationId)}=$4 AND s.account_generation=$3 AND s.version=$5`,
          [
            row.snapshot.accountId,
            actor.membershipId,
            row.snapshot.generation,
            contextId(conversationId),
            row.snapshot.selectionVersion,
          ],
        );
        const origin = row.snapshot.origin;
        const current =
          origin.kind === 'chat'
            ? await tx.client.query(
                `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND generation=$2 AND status IN ('processing','completed')`,
                [origin.turnId, origin.generation],
              )
            : await tx.client.query(
                `SELECT 1 FROM ${qualified(tx.schema, 'tf_agent_tasks')} WHERE id=$1 AND generation=$2 AND status IN ('pending','waiting-approval')`,
                [origin.taskId, origin.generation],
              );
        if (!selected.rowCount || !current.rowCount) throw new GitHubBatchError('batch-conflict');
        const previous = await batchView(tx, row);
        if (previous.decision && previous.decision !== decision.decision) throw new GitHubBatchError('batch-conflict');
        if (!previous.decision)
          await tx.client.query(
            `INSERT INTO ${batchTable(tx, 'batch_decisions')} (batch_id,membership_id,digest,decision) VALUES ($1,$2,$3,$4)`,
            [id, actor.membershipId, row.digest, decision.decision],
          );
        return batchView(tx, row);
      },
    });
  };
}
