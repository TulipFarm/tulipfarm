import type { Pool } from 'pg';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { z } from 'zod';
import { disableWorkspace } from '@tulipfarm/workspaces/operators';
import {
  inTransaction,
  lockWorkspaceMigration,
  qualified,
  workspaceNames,
} from '@tulipfarm/workspace-storage/provisioning';
import type { WorkspaceLifecycle } from './workspace-operations-lifecycle.ts';

export function createWorkspaceTeardownLifecycle(options: {
  pool: Pool;
  temporal: Client;
  operationId: string;
}): WorkspaceLifecycle {
  const operationId = z.uuid().parse(options.operationId);
  async function assertUnavailable(workspaceId: string) {
    const result = await options.pool.query(
      `SELECT 1 FROM app.workspace_storage
      WHERE workspace_id = $1 AND stage = 'unavailable' AND disabled_at IS NOT NULL`,
      [workspaceNames(workspaceId).workspaceId],
    );
    if (result.rowCount !== 1) throw new Error('workspace-tombstone-required');
  }
  return {
    async markUnavailable(workspaceId) {
      await disableWorkspace(options.pool, workspaceId, operationId);
    },
    assertUnavailable,
    async stopJobs(workspaceId) {
      const names = workspaceNames(workspaceId);
      await assertUnavailable(names.workspaceId);
      const client = await options.pool.connect();
      let workflows: string[];
      try {
        workflows = await inTransaction(client, async transaction => {
          await lockWorkspaceMigration(transaction, names.workspaceId);
          const exists = (await transaction.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [names.schema]))
            .rowCount;
          const ids = [`workspace-storage-v1-${names.workspaceId}`];
          if (!exists) return ids;
          const table = (name: string) => qualified(names.schema, name);
          await transaction.query(`SELECT id FROM ${table('tf_authorization_lock')} WHERE id = 1 FOR UPDATE`);
          const jobs = z
            .array(z.object({ id: z.uuid() }))
            .parse((await transaction.query(`SELECT id FROM ${table('tf_migration_jobs')}`)).rows);
          const commands = z
            .array(z.object({ id: z.uuid() }))
            .parse((await transaction.query(`SELECT id FROM ${table('tf_authoring_commands')}`)).rows);
          ids.push(
            ...jobs.map(job => `table-migration-v1-${names.workspaceId}-${job.id}`),
            ...commands.map(command => `table-save-v1-${names.workspaceId}-${command.id}`),
          );
          await transaction.query(`UPDATE ${table('tf_migration_jobs')} SET status = 'rejected', error_code = 'workspace-unavailable', updated_at = now()
            WHERE status NOT IN ('applied', 'rejected', 'superseded')`);
          await transaction.query(
            `UPDATE ${table('tf_authoring_commands')} SET status = 'failed' WHERE status = 'preparing'`,
          );
          const optional = [
            [
              'tf_table_controls',
              "SET processed_at = now(), outcome = 'workspace-unavailable' WHERE processed_at IS NULL",
            ],
            ['tf_agent_runs', "SET status = 'cancelled' WHERE status NOT IN ('completed', 'cancelled')"],
            ['tf_agent_tool_calls', "SET status = 'blocked' WHERE status IN ('pending', 'waiting')"],
          ];
          for (const [name, update] of optional) {
            if (
              name &&
              update &&
              (await transaction.query('SELECT to_regclass($1) AS relation', [table(name)])).rows[0]?.relation
            ) {
              await transaction.query(`UPDATE ${table(name)} ${update}`);
            }
          }
          await transaction.query(
            `INSERT INTO ${table('tf_audit_events')} (id, actor_id, operation, subject_id)
            VALUES ($1, session_user, 'operator.teardown.stopped', $2) ON CONFLICT (id) DO NOTHING`,
            [operationId, names.workspaceId],
          );
          return ids;
        });
      } finally {
        client.release();
      }
      for (const workflowId of workflows) {
        try {
          await options.temporal.workflow.getHandle(workflowId).terminate('Workspace unavailable');
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError)) throw error;
        }
      }
    },
    async drainPools(workspaceId) {
      await assertUnavailable(workspaceId);
      const names = workspaceNames(workspaceId);
      await options.pool.query(
        'SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usename = ANY($1) AND pid <> pg_backend_pid()',
        [[names.runtime, names.migration, names.confirmation]],
      );
    },
  };
}
