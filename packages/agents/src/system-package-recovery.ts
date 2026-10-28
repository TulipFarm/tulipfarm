import { z } from 'zod';
import { proposalManifestSchema, executionReceiptSchema } from '@tulipfarm/tables/proposal-contracts';
import { relation, type AgentTransaction } from './store.ts';

const executionsSchema = z.array(
  z.object({
    phase: z.enum(['publishing', 'copying', 'reconciling', 'completed', 'blocked']),
    revision: z.string().nullable(),
    target_generation: z.uuid().nullable(),
    error_code: z.string().nullable(),
  }),
);
export async function inspectTableRecovery(
  tx: AgentTransaction,
  input: {
    installationId: string;
    proposalId: string;
    membershipId: string;
    knownStale: boolean;
    cancellationId: string;
  },
) {
  const proposal = z
    .object({
      manifest: proposalManifestSchema,
      expired: z.boolean(),
      cancelled_for_refresh: z.boolean(),
    })
    .parse(
      (
        await tx.client.query(
          `SELECT manifest,expires_at<=clock_timestamp() AS expired,
      EXISTS(SELECT 1 FROM ${relation(tx, 'tf_table_proposal_controls')} c
        WHERE c.proposal_id=p.id AND c.command_id=$4 AND c.operation='cancel') AS cancelled_for_refresh
     FROM ${relation(tx, 'tf_table_proposals')} p
     WHERE p.id=$1 AND p.installation_id=$2 AND p.membership_id=$3 AND p.redacted_at IS NULL`,
          [input.proposalId, input.installationId, input.membershipId, input.cancellationId],
        )
      ).rows[0],
    );
  const executions = executionsSchema.parse(
    (
      await tx.client.query(
        `SELECT phase,revision,target_generation,error_code FROM ${relation(tx, 'tf_table_executions')} WHERE proposal_id=$1`,
        [input.proposalId],
      )
    ).rows,
  );
  const receipts = z
    .array(z.object({ table_id: z.uuid(), receipt: executionReceiptSchema }))
    .parse(
      (
        await tx.client.query(
          `SELECT table_id,receipt FROM ${relation(tx, 'tf_table_proposal_receipts')} WHERE proposal_id=$1 ORDER BY attempt`,
          [input.proposalId],
        )
      ).rows,
    );
  const completed = new Set(receipts.filter(row => row.receipt.status === 'completed').map(row => row.table_id));
  if (proposal.manifest.plans.every(plan => completed.has(plan.input.tableId)))
    return { kind: 'completed' as const, receipts: receipts.filter(row => row.receipt.status === 'completed') };
  if (completed.size) return { kind: 'uncertain' as const, reason: 'table-recovery-partially-applied' };
  const stale = input.knownStale || executions.some(execution => execution.error_code === 'proposal-stale');
  if (!proposal.expired && !stale && !proposal.cancelled_for_refresh) return { kind: 'unchanged' as const };
  if (
    executions.some(
      execution =>
        execution.phase !== 'blocked' ||
        execution.revision !== null ||
        execution.target_generation !== null ||
        (execution.error_code !== null &&
          !['proposal-stale', 'proposal-expired', 'proposal-cancelled'].includes(execution.error_code)),
    )
  )
    return { kind: 'uncertain' as const, reason: 'table-recovery-outcome-unknown' };
  return {
    kind: 'refresh' as const,
    reason: proposal.expired ? 'proposal-expired' : 'proposal-stale',
    digest: proposal.manifest,
  };
}
