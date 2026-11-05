import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { agentWorkflowCommonVersion } from '@tulipfarm/workflows';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  agentTriggerDefinition,
  createAgentTriggerWorkflow,
  derivedId,
  type AgentWorkflowOptions,
} from './agent-trigger-workflows.ts';
import { boundRuntime } from './task-approval-gate.ts';
import { taskLimitsSchema } from './task-contracts.ts';
import { relation, type AgentStorage } from './store.ts';

const legacySchema = z.object({
  id: z.uuid(),
  activation_id: z.uuid(),
  agent_id: z.uuid(),
  name: z.string().min(1),
  interval_minutes: z.number().int().nullable(),
  cron_expression: z.string().nullable(),
  timezone: z.string().nullable(),
  call: z.strictObject({ kind: z.literal('task'), text: z.string().min(1).max(8000), limits: taskLimitsSchema }),
  paused: z.boolean(),
  user_id: z.string(),
});

/**
 * Moves agent task schedules into Workflows that run the same agent, one schedule per transaction.
 * Each Workflow pins the schedule's activation, runs as its sponsor and starts disabled when the schedule was paused.
 * Inspection schedules stay where they are.
 */
export function createAgentScheduleMigration(runtime: AgentStorage, options: AgentWorkflowOptions = {}) {
  const failed = new Set<string>();
  async function migrate(workspaceId: string, onError?: (scheduleId: string, error: unknown) => void) {
    const pending = await runtime.transaction(workspaceId, commonCompatibility, async tx =>
      tx.commonVersion < agentWorkflowCommonVersion
        ? []
        : z
            .array(z.object({ id: z.uuid() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT s.id FROM ${relation(tx, 'tf_agent_schedules')} s JOIN ${relation(tx, 'tf_agent_activations')} a ON a.id=s.activation_id JOIN ${relation(tx, 'tf_agents')} g ON g.id=a.agent_id WHERE s.revoked_at IS NULL AND a.revoked_at IS NULL AND g.enabled AND g.deleted_at IS NULL AND s.call->>'kind'='task' ORDER BY s.id LIMIT 20`,
                )
              ).rows,
            )
            .filter(row => !failed.has(row.id)),
    );
    let migrated = 0;
    for (const { id } of pending) {
      try {
        await runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx, 'write');
          const row = legacySchema
            .optional()
            .parse(
              (
                await tx.client.query(
                  `SELECT s.id,s.activation_id,a.agent_id,d.definition->>'name' AS name,s.interval_minutes,s.cron_expression,s.timezone,s.call,(s.paused_at IS NOT NULL) AS paused,m.user_id FROM ${relation(tx, 'tf_agent_schedules')} s JOIN ${relation(tx, 'tf_agent_activations')} a ON a.id=s.activation_id JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=a.agent_id AND d.revision=a.definition_revision JOIN ${relation(tx, 'tf_memberships')} m ON m.id=s.sponsor_membership_id AND m.removed_at IS NULL WHERE s.id=$1 AND s.revoked_at IS NULL AND a.revoked_at IS NULL FOR UPDATE OF s`,
                  [id],
                )
              ).rows[0],
            );
          if (!row) throw new Error('schedule-sponsor-unavailable');
          const actor = await resolveHuman(tx, row.user_id);
          const trigger =
            row.cron_expression && row.timezone
              ? { kind: 'cron' as const, expression: row.cron_expression, timezone: row.timezone }
              : { kind: 'interval' as const, minutes: z.number().int().parse(row.interval_minutes) };
          await createAgentTriggerWorkflow(
            tx,
            boundRuntime(tx, workspaceId),
            workspaceId,
            actor,
            {
              id: derivedId('schedule', row.id),
              agentId: row.agent_id,
              definition: agentTriggerDefinition(
                { id: row.agent_id, name: row.name },
                { trigger, prompt: row.call.text, limits: row.call.limits },
                row.activation_id,
              ),
              enabled: !row.paused,
            },
            options,
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_schedules')} SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`,
            [row.id],
          );
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'agent.schedule.revoke',$3)`,
            [randomUUID(), actor.membershipId, row.id],
          );
        });
        migrated++;
      } catch (error) {
        // A schedule that cannot move keeps running as before until a restart retries it.
        failed.add(id);
        onError?.(id, error);
      }
    }
    return { migrated };
  }
  return { migrate };
}
