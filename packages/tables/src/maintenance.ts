import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  currentMember,
  requireTablePermission,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { TableError } from './service-contracts.ts';
import { catalog, migrationJob, table } from './service-store.ts';

const storedPlanSchema = z.object({
  digest: z.string(),
  commonVersion: z.number(),
  targetRevision: z.string(),
  workspaceSchema: z.string(),
  impact: z.object({ rowCount: z.number() }).passthrough().nullable(),
});

export async function lockConfirmationProposal(
  transaction: AuthorizationTransaction,
  actor: HumanActor,
  migrationId: string,
  planDigest: string,
) {
  await currentMember(transaction, actor);
  const job = await migrationJob(transaction, migrationId);
  const item = await catalog(transaction, job.table_id, 'write');
  await requireTablePermission(transaction, actor, job.table_id, 'table.schema.manage');
  const currentJob = await migrationJob(transaction, migrationId);
  if (currentJob.status !== job.status || item.applied_revision !== job.expected_applied_revision)
    throw new TableError('stale-plan');
  if (job.status !== 'waiting_for_confirmation' || job.plan_digest !== planDigest) throw new TableError('stale-plan');
  const plan = storedPlanSchema.parse(job.plan);
  const commonVersion = z
    .object({ version: z.number() })
    .parse(
      (
        await transaction.client.query(
          `SELECT count(*)::int AS version FROM ${table(transaction, 'tf_common_migrations')}`,
        )
      ).rows[0],
    ).version;
  if (
    commonVersion !== plan.commonVersion ||
    plan.targetRevision !== job.target_revision ||
    plan.workspaceSchema !== transaction.schema
  )
    throw new TableError('stale-plan');
  if (plan.digest !== planDigest || !plan.impact || !plan.impact.rowCount) throw new TableError('invalid-confirmation');
  return { job, plan: { digest: plan.digest, impact: plan.impact } };
}

export async function recordTableConfirmation(
  transaction: AuthorizationTransaction,
  workspaceId: string,
  actor: HumanActor,
  proposal: Awaited<ReturnType<typeof lockConfirmationProposal>>,
  expiresAt?: Date,
) {
  const { job, plan } = proposal;
  const existing = (
    await transaction.client.query(
      `SELECT id, expires_at FROM ${table(transaction, 'tf_confirmations')} WHERE migration_id = $1 AND plan_digest = $2 AND membership_id = $3 AND consumed_at IS NULL AND expires_at > clock_timestamp() ORDER BY expires_at DESC LIMIT 1`,
      [job.id, plan.digest, actor.membershipId],
    )
  ).rows[0];
  const receipt =
    existing ??
    (
      await transaction.client.query(
        `INSERT INTO ${table(transaction, 'tf_confirmations')} (id, workspace_id, table_id, migration_id, plan_digest, expected_applied_revision, destructive_effect, membership_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,LEAST(clock_timestamp() + interval '24 hours', $9::timestamptz)) RETURNING id, expires_at`,
        [
          randomUUID(),
          workspaceId,
          job.table_id,
          job.id,
          plan.digest,
          job.expected_applied_revision,
          plan.impact,
          actor.membershipId,
          expiresAt ?? null,
        ],
      )
    ).rows[0];
  if (!receipt) throw new TableError('confirmation-expired');
  const value = z.object({ id: z.uuid(), expires_at: z.date() }).parse(receipt);
  return { id: value.id, migrationId: job.id, expiresAt: value.expires_at.toISOString() };
}
