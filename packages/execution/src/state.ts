import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  executionDescriptorSchema,
  executionProfileSchema,
  type ExecutionConfiguration,
  type ExecutionDescriptor,
  type ExecutionProfile,
} from '@tulipfarm/execution-contract';
import { qualified, type SqlClient } from '@tulipfarm/workspace-storage/runtime';

export type ExecutionTransaction = { schema: string; client: SqlClient };
export class ExecutionConflict extends Error {
  constructor(
    readonly code: 'disabled' | 'not-found' | 'busy' | 'consent-required' | 'stale' | 'request-conflict' | 'quota',
  ) {
    super(`Execution ${code}`);
  }
}
export const table = (tx: ExecutionTransaction, name: string) => qualified(tx.schema, name);
export const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const areaSchema = z.object({
  id: z.uuid(),
  conversation_id: z.uuid(),
  generation: z.number().int().positive(),
  profile: executionProfileSchema,
  policy_revision: z.string(),
  scope_revision: z.string(),
  base_revision: z.string(),
  consent_revision: z.number().int().nonnegative(),
  manifest_id: z.uuid().nullable(),
  state: z.enum(['active', 'deleting', 'deleted']),
});
export type ExecutionArea = z.infer<typeof areaSchema>;
export type ExecutionScope = {
  profile: ExecutionProfile;
  policyRevision: string;
  scopeRevision: string;
  baseRevision: string;
};

export function executionScope(
  configuration: ExecutionConfiguration,
  descriptor: ExecutionDescriptor,
  profileId?: string,
): ExecutionScope {
  if (configuration.mode === 'off') throw new ExecutionConflict('disabled');
  const profile = configuration.policy.profiles.find(
    item => item.id === (profileId ?? configuration.policy.defaultProfile),
  );
  if (!profile) throw new ExecutionConflict('request-conflict');
  const capabilities = executionDescriptorSchema.parse(descriptor).capabilities;
  return {
    profile,
    policyRevision: configuration.policyRevision,
    scopeRevision: requestHash({ policyRevision: configuration.policyRevision, profile, capabilities }),
    baseRevision: configuration.policy.baseRevision,
  };
}

/** Callers hold the chat authorization lock before taking an area lock. */
export async function findArea(tx: ExecutionTransaction, conversationId: string) {
  return areaSchema
    .optional()
    .parse(
      (
        await tx.client.query(`SELECT * FROM ${table(tx, 'tf_execution_areas')} WHERE conversation_id=$1 FOR UPDATE`, [
          z.uuid().parse(conversationId),
        ])
      ).rows[0],
    );
}

export async function ensureArea(tx: ExecutionTransaction, conversationId: string, scope: ExecutionScope) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_areas')}
      (id,conversation_id,profile,policy_revision,scope_revision,base_revision) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (conversation_id) DO NOTHING`,
    [randomUUID(), conversationId, scope.profile, scope.policyRevision, scope.scopeRevision, scope.baseRevision],
  );
  const area = await findArea(tx, conversationId);
  if (!area || area.state !== 'active') throw new ExecutionConflict('not-found');
  return area;
}

export async function requireIdle(tx: ExecutionTransaction, area: ExecutionArea) {
  const result = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_execution_jobs')} WHERE area_id=$1 AND state NOT IN ('completed','cancelled','timed-out')
     UNION ALL SELECT 1 FROM ${table(tx, 'tf_execution_allocations')} WHERE area_id=$1 AND state<>'stopped' LIMIT 1`,
    [area.id],
  );
  if (result.rowCount) throw new ExecutionConflict('busy');
}

export async function hasConsent(tx: ExecutionTransaction, area: ExecutionArea, scope: ExecutionScope) {
  if (area.state !== 'active' || area.scope_revision !== scope.scopeRevision) return false;
  return !!(
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_execution_consents')} c
      JOIN ${table(tx, 'tf_memberships')} m ON m.id=c.membership_id AND m.removed_at IS NULL
      WHERE c.area_id=$1 AND c.revision=$2 AND c.scope_revision=$3 AND c.revoked_at IS NULL`,
      [area.id, area.consent_revision, scope.scopeRevision],
    )
  ).rowCount;
}

export async function grantConsent(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  membershipId: string,
  scope: ExecutionScope,
) {
  if (await hasConsent(tx, area, scope)) return area;
  await requireIdle(tx, area);
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_consents')} SET revoked_at=clock_timestamp() WHERE area_id=$1 AND revoked_at IS NULL`,
    [area.id],
  );
  const updated = areaSchema.parse(
    (
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_execution_areas')} SET profile=$2,policy_revision=$3,scope_revision=$4,base_revision=$5,
      consent_revision=consent_revision+1 WHERE id=$1 AND state='active' RETURNING *`,
        [area.id, scope.profile, scope.policyRevision, scope.scopeRevision, scope.baseRevision],
      )
    ).rows[0],
  );
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_consents')} (area_id,revision,scope_revision,membership_id) VALUES ($1,$2,$3,$4)`,
    [area.id, updated.consent_revision, scope.scopeRevision, membershipId],
  );
  return updated;
}

export async function enqueueIntent(
  tx: ExecutionTransaction,
  area: Pick<ExecutionArea, 'id' | 'generation'>,
  operation: 'start' | 'poll' | 'stop' | 'cleanup' | 'resume',
  key: string,
  jobId: string | null = null,
) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_outbox')} (id,area_id,generation,job_id,operation,dedupe_key)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), area.id, area.generation, jobId, operation, key],
  );
}

export async function cancelAreaJobs(tx: ExecutionTransaction, area: ExecutionArea) {
  const jobs = await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_jobs')} SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
      finished_at=CASE WHEN state='queued' THEN clock_timestamp() ELSE finished_at END,
      state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END
      WHERE area_id=$1 AND state NOT IN ('completed','cancelled','timed-out') RETURNING id,state,generation`,
    [area.id],
  );
  for (const value of jobs.rows) {
    const job = z.object({ id: z.uuid(), state: z.string(), generation: z.number().int().positive() }).parse(value);
    const operation = job.state === 'cancelled' ? 'resume' : 'stop';
    await enqueueIntent(tx, { id: area.id, generation: job.generation }, operation, `${job.id}:${operation}`, job.id);
  }
  await enqueueIntent(tx, area, 'cleanup', `${area.id}:${area.generation}:cleanup`);
}

export async function revokeConsent(tx: ExecutionTransaction, area: ExecutionArea) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_consents')} SET revoked_at=clock_timestamp() WHERE area_id=$1 AND revoked_at IS NULL`,
    [area.id],
  );
  await cancelAreaJobs(tx, area);
}
