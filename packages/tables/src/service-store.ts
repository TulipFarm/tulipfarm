import { z } from 'zod';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { lockAuthorization, resolveActor, type Actor, type AuthorizationTransaction } from '@tulipfarm/access';
import { migrationStatusSchema, TableError } from './service-contracts.ts';

export type TableRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export type TableTransaction = AuthorizationTransaction & { workspaceId: string; commonVersion: number };
export const compatibility = commonCompatibility;
export const catalogSchema = z.object({
  id: z.uuid(),
  owning_team_id: z.uuid(),
  physical_table: z.string(),
  display_name: z.string(),
  target_revision: z.string(),
  applied_revision: z.string().nullable(),
  applied_definition: z.unknown(),
  maintenance: z.boolean(),
});
export const jobSchema = z.object({
  id: z.uuid(),
  table_id: z.uuid(),
  command_id: z.uuid(),
  membership_id: z.uuid().nullable(),
  agent_run_id: z.uuid().nullable().optional(),
  target_revision: z.string(),
  expected_applied_revision: z.string().nullable(),
  predecessor_id: z.uuid().nullable(),
  status: migrationStatusSchema,
  plan: z.unknown(),
  plan_digest: z.string().nullable(),
  planner_version: z.number().nullable(),
  common_version: z.number().nullable(),
  error_code: z.string().nullable(),
  created_at: z.date(),
});
export const table = (transaction: AuthorizationTransaction, name: string) => qualified(transaction.schema, name);

export function withActor<T>(
  runtime: TableRuntime,
  workspaceId: string,
  principal: string | Actor,
  operation: (transaction: TableTransaction, actor: Actor) => Promise<T>,
) {
  return runtime.transaction(workspaceId, compatibility, async transaction => {
    await lockAuthorization(transaction);
    const actor = await resolveActor(transaction, principal);
    if (actor.kind === 'agent')
      await transaction.client.query(`SELECT id FROM ${table(transaction, 'tf_agent_runs')} WHERE id=$1 FOR UPDATE`, [
        actor.runId,
      ]);
    return operation(transaction, actor);
  });
}

export async function catalog(transaction: AuthorizationTransaction, tableId: string, mode: 'read' | 'write' = 'read') {
  const row = (
    await transaction.client.query(
      `SELECT * FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $1 FOR ${mode === 'write' ? 'UPDATE' : 'SHARE'}`,
      [tableId],
    )
  ).rows[0];
  if (row?.applied_definition?.formatVersion === 2) throw new TableError('applied-revision-conflict');
  const value = catalogSchema.optional().parse(row);
  if (!value) throw new TableError('table-not-found', 404);
  return value;
}

export async function migrationJob(transaction: AuthorizationTransaction, migrationId: string) {
  const row = (
    await transaction.client.query(`SELECT * FROM ${table(transaction, 'tf_migration_jobs')} WHERE id = $1`, [
      migrationId,
    ])
  ).rows[0];
  const value = jobSchema.optional().parse(row);
  if (!value) throw new TableError('migration-not-found', 404);
  return value;
}
