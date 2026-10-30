import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { createTemporalClient } from './temporal.ts';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createAgentSchedules } from '@tulipfarm/agents/schedules';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { errorAttributes } from '@tulipfarm/observability';

export function registerTableDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    runtime: WorkspaceRuntime;
    temporal: ReturnType<typeof createTemporalClient>;
    wakeTask?: (workspaceId: string, taskId: string) => Promise<void>;
  },
) {
  const { pool, runtime, temporal } = dependencies;
  const schedules = createAgentSchedules(runtime);
  let after: string | null = null;
  async function sweep(stopped: () => boolean) {
    const rows = await readyWorkspaces(pool, after, 100);
    for (const row of rows) {
      if (stopped()) return;
      try {
        const proposals = await runtime.transaction(row.workspace_id, executionCompatibility, async tx =>
          z.array(z.object({ id: z.uuid() })).parse(
            (
              await tx.client.query(`SELECT p.id FROM ${qualified(tx.schema, 'tf_table_proposals')} p
          JOIN ${qualified(tx.schema, 'tf_table_proposal_decisions')} d
            ON d.proposal_id=p.id AND d.digest=p.digest AND d.membership_id=p.membership_id
          LEFT JOIN LATERAL (
            SELECT sequence,operation,digest,membership_id FROM ${qualified(tx.schema, 'tf_table_proposal_controls')}
            WHERE proposal_id=p.id ORDER BY sequence DESC LIMIT 1
          ) c ON true
          WHERE d.decision='approve' AND p.expires_at>clock_timestamp()
            AND (c.sequence IS NULL OR (c.operation='resume' AND c.digest=p.digest AND c.membership_id=p.membership_id))
            AND NOT EXISTS (
              SELECT 1 FROM ${qualified(tx.schema, 'tf_table_executions')} e
              WHERE e.proposal_id=p.id AND e.phase='blocked'
                AND (c.sequence IS NULL OR c.sequence<=e.resumed_sequence)
            )
            AND (SELECT count(*) FROM ${qualified(tx.schema, 'tf_table_proposal_receipts')} r
              WHERE r.proposal_id=p.id AND r.receipt->>'status'='completed')<jsonb_array_length(p.manifest->'plans')
          ORDER BY p.id LIMIT 20
        `)
            ).rows,
          ),
        );
        for (const proposal of proposals)
          await temporal.connection.withDeadline(Date.now() + 10000, () =>
            temporal.client.workflow.start('executeTableProposal', {
              workflowId: `table-proposal-v2-${row.workspace_id}-${proposal.id}`,
              taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
              args: [row.workspace_id, proposal.id, process.env.TEMPORAL_STORAGE_TASK_QUEUE ?? 'tulipfarm-storage-v1'],
              workflowIdConflictPolicy: 'USE_EXISTING',
              workflowIdReusePolicy: 'ALLOW_DUPLICATE',
            }),
          );
      } catch (error) {
        app.log.error(
          { workspaceId: row.workspace_id, ...errorAttributes(error) },
          'Table proposal dispatch will retry',
        );
      }
      try {
        const commands = await runtime.transaction(row.workspace_id, commonCompatibility, async transaction =>
          z
            .array(z.object({ id: z.uuid() }))
            .parse(
              (
                await transaction.client.query(
                  `SELECT id FROM ${qualified(transaction.schema, 'tf_agent_commands')} WHERE status = 'preparing' ORDER BY dispatched_at NULLS FIRST, created_at, id LIMIT 20`,
                )
              ).rows,
            ),
        );
        for (const command of commands) {
          await temporal.connection.withDeadline(Date.now() + 10000, () =>
            temporal.client.workflow.start('prepareAgentSave', {
              workflowId: `agent-save-v1-${row.workspace_id}-${command.id}`,
              taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
              args: [row.workspace_id, command.id],
              workflowIdConflictPolicy: 'USE_EXISTING',
              workflowIdReusePolicy: 'ALLOW_DUPLICATE',
            }),
          );
          await runtime.transaction(row.workspace_id, commonCompatibility, transaction =>
            transaction.client.query(
              `UPDATE ${qualified(transaction.schema, 'tf_agent_commands')} SET dispatched_at = now() WHERE id = $1`,
              [command.id],
            ),
          );
        }
      } catch (error) {
        app.log.error({ workspaceId: row.workspace_id, ...errorAttributes(error) }, 'Agent dispatch will retry');
      }
      try {
        for (const ids of await schedules.due(row.workspace_id, dependencies.wakeTask)) {
          await temporal.connection.withDeadline(Date.now() + 10000, () =>
            temporal.client.workflow.start('boundedAgentTool', {
              workflowId: `agent-scheduled-tool-v1-${ids.workspaceId}-${ids.callId}`,
              taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
              args: [ids],
              workflowIdConflictPolicy: 'USE_EXISTING',
              workflowIdReusePolicy: 'ALLOW_DUPLICATE',
            }),
          );
        }
      } catch (error) {
        app.log.error({ workspaceId: row.workspace_id, ...errorAttributes(error) }, 'Schedule dispatch will retry');
      }
      after = row.workspace_id;
    }
    if (rows.length < 100) after = null;
  }
  backgroundSweep(app, sweep, 'Table dispatch discovery will retry', 'table-dispatch');
}
