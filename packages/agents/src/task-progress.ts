import { z } from 'zod';
import { lockTask } from './task-approval-gate.ts';
import { relation, type AgentStorage } from './store.ts';
import { taskReceiptSchema } from './task-contracts.ts';
import { recoverableTaskModels } from './task-model-accounting.ts';
import { taskGitHubWaiting } from './github-tasks.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export type TaskProgress = { kind: 'accounting' } | { kind: 'runnable' } | { kind: 'waiting' } | { kind: 'terminal' };

export function createTaskProgress(runtime: AgentStorage) {
  return async (workspaceId: string, taskId: string): Promise<TaskProgress> => {
    taskId = z.uuid().parse(taskId);
    return runtime.transaction(z.uuid().parse(workspaceId), commonCompatibility, async tx => {
      await lockTask(tx, taskId);
      const task = taskReceiptSchema
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT id,generation,status FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1`, [
              taskId,
            ])
          ).rows[0],
        );
      if (!task) return { kind: 'terminal' };
      if ((await recoverableTaskModels(tx, taskId)).length) return { kind: 'accounting' };
      if (task.status === 'completed' || task.status === 'failed') return { kind: 'terminal' };
      if (task.status === 'paused' || task.status === 'waiting-clarification') return { kind: 'waiting' };
      if (task.status === 'pending') return { kind: 'runnable' };
      const github = z
        .object({ call_id: z.uuid() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT s.call_id FROM ${relation(tx, 'tf_agent_task_steps')} s JOIN ${relation(tx, 'tf_agent_tool_calls')} c ON c.id=s.call_id WHERE s.task_id=$1 AND s.generation=$2 AND NOT s.completed AND c.call->>'tool'='github.personal.propose'`,
              [taskId, task.generation],
            )
          ).rows[0],
        );
      if (github) return { kind: (await taskGitHubWaiting(tx, github.call_id)) ? 'waiting' : 'runnable' };
      const mcp = z
        .object({ runnable: z.boolean() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT COALESCE((r.status='succeeded' OR (c.action_id IS NULL AND (a.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM ${relation(tx, 'tf_mcp_decisions')} d WHERE d.action_id=a.id))) OR EXISTS(SELECT 1 FROM ${relation(tx, 'tf_mcp_cancellations')} x WHERE x.action_id=a.id) OR EXISTS(SELECT 1 FROM ${relation(tx, 'tf_mcp_reconciliations')} x WHERE x.action_id=a.id AND x.observation<>'still-unknown') OR (c.deadline<=clock_timestamp() AND r.action_id IS NULL)),false) AS runnable FROM ${relation(tx, 'tf_agent_task_steps')} s JOIN ${relation(tx, 'tf_mcp_actions')} a ON a.id=s.call_id LEFT JOIN ${relation(tx, 'tf_mcp_claims')} c ON c.action_id=a.id LEFT JOIN ${relation(tx, 'tf_mcp_receipts')} r ON r.action_id=a.id WHERE s.task_id=$1 AND s.generation=$2 AND NOT s.completed`,
              [taskId, task.generation],
            )
          ).rows[0],
        );
      if (mcp) return { kind: mcp.runnable ? 'runnable' : 'waiting' };
      const slack = z
        .object({ runnable: z.boolean() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT (e.state NOT IN ('pending','retry','sending') OR a.expires_at<=clock_timestamp() OR (e.state='pending' AND (NOT a.approval_required OR d.decision IS NOT NULL)) OR (e.state IN ('retry','sending') AND e.next_attempt_at<=clock_timestamp())) AS runnable FROM ${relation(tx, 'tf_agent_task_steps')} s JOIN ${relation(tx, 'tf_slack_actions')} a ON a.id=s.call_id JOIN ${relation(tx, 'tf_slack_action_effects')} e ON e.action_id=a.id LEFT JOIN ${relation(tx, 'tf_slack_action_decisions')} d ON d.action_id=a.id WHERE s.task_id=$1 AND s.generation=$2 AND NOT s.completed`,
              [taskId, task.generation],
            )
          ).rows[0],
        );
      if (slack) return { kind: slack.runnable ? 'runnable' : 'waiting' };
      const step = z
        .object({ proposal_id: z.uuid().nullable() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT proposal_id FROM ${relation(tx, 'tf_agent_task_steps')} WHERE task_id=$1 AND generation=$2 AND NOT completed`,
              [taskId, task.generation],
            )
          ).rows[0],
        );
      if (!step?.proposal_id) return { kind: 'waiting' };
      let proposalId = step.proposal_id;
      for (let depth = 0; depth < 100; depth++) {
        const successor = z
          .object({ successor_id: z.uuid() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT successor_id FROM ${relation(tx, 'tf_agent_task_supersessions')} WHERE proposal_id=$1`,
                [proposalId],
              )
            ).rows[0],
          );
        if (successor) {
          proposalId = successor.successor_id;
          continue;
        }
        const approval = z.object({ decision: z.enum(['approve', 'reject']).nullable(), failed: z.boolean() }).parse(
          (
            await tx.client.query(
              `SELECT d.decision, EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.actions) a
            JOIN ${relation(tx, 'tf_agent_task_action_receipts')} r ON r.call_id=(a->>'id')::uuid
            WHERE r.status IN ('failed','blocked')
          ) AS failed FROM ${relation(tx, 'tf_agent_task_proposals')} p
          LEFT JOIN ${relation(tx, 'tf_agent_task_decisions')} d ON d.proposal_id=p.id
          WHERE p.id=$1 AND p.task_id=$2 AND p.generation=$3`,
              [proposalId, taskId, task.generation],
            )
          ).rows[0],
        );
        return {
          kind:
            approval.decision === 'reject' || (approval.decision === 'approve' && !approval.failed)
              ? 'runnable'
              : 'waiting',
        };
      }
      throw new Error('task-recovery-limit');
    });
  };
}
