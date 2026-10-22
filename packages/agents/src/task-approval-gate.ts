import { z } from 'zod';
import {
  AccessDenied,
  githubTaskContext,
  requireNoMcpDerived,
  requireTablePermission,
  resolveHuman,
  type HumanActor,
} from '@tulipfarm/access';
import { createAgentRecordTools, requireAgentRecordFiles } from './record-tools.ts';
import { GenerationError } from '@tulipfarm/tables/store';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { withTaskMutation } from '@tulipfarm/tables/task-admission';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { createAgentTasks } from './tasks.ts';
import { toolCallSchema, toolResultSchema, type ToolCall } from './contracts.ts';
import { taskProposalSchema, TaskApprovalError, type taskActionSchema } from './task-approval-contracts.ts';
import { requireTaskDefinitionSources } from './draft-sources.ts';
import type { TaskWork } from './task-activity.ts';
import { githubTaskResultSchema } from './github-task-contracts.ts';
import { requireDraftSources } from './draft-sources.ts';
import { taskTransition } from './task-telemetry.ts';

// Nested domain operations retain the outer authorization, task, schema and record locks.
export const boundRuntime = (tx: AgentTransaction & { commonVersion: number }, workspaceId: string): AgentStorage => ({
  transaction: async (id, range, operation) => {
    if (
      id.toLowerCase() !== workspaceId.toLowerCase() ||
      tx.commonVersion < range.minimum ||
      tx.commonVersion > range.maximum
    )
      throw new AccessDenied();
    return operation({ ...tx, workspaceId });
  },
});
export async function taskRun(tx: AgentTransaction, runId: string) {
  return z
    .object({
      task_id: z.uuid(),
      generation: z.number(),
      owner_user_id: z.string(),
      owner_membership_id: z.uuid(),
      current_generation: z.number(),
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT b.task_id,b.generation,t.owner_user_id,t.owner_membership_id,t.generation AS current_generation FROM ${relation(tx, 'tf_agent_task_runs')} b JOIN ${relation(tx, 'tf_agent_tasks')} t ON t.id=b.task_id WHERE b.run_id=$1`,
          [runId],
        )
      ).rows[0],
    );
}
export async function lockTask(tx: AgentTransaction, taskId: string) {
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 648291))', [`${tx.schema}:${taskId}`]);
}
export async function loadTaskProposal(tx: AgentTransaction, id: string) {
  const value = taskProposalSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT id,task_id AS "taskId",generation,run_id AS "runId",digest,actions FROM ${relation(tx, 'tf_agent_task_proposals')} WHERE id=$1`,
          [id],
        )
      ).rows[0],
    );
  if (!value) throw new AccessDenied();
  return value;
}
export async function taskOutputAllowed(
  tx: AgentTransaction & { commonVersion: number },
  workspaceId: string,
  runId: string,
  execute: boolean,
) {
  const binding = await taskRun(tx, runId);
  if (!binding || (execute && binding.generation !== binding.current_generation)) throw new AccessDenied();
  if (
    execute &&
    !(
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1 AND status IN ('pending','waiting-approval')`,
        [binding.task_id],
      )
    ).rowCount
  )
    throw new AccessDenied();
  const owner = await resolveHuman(tx, binding.owner_user_id);
  if (owner.membershipId !== binding.owner_membership_id) throw new AccessDenied();
  await requireTaskDefinitionSources(tx, owner, binding.task_id, execute ? runId : undefined);
  const runtime = boundRuntime(tx, workspaceId);
  const tasks = createAgentTasks(runtime);
  let after: number | null = -1;
  while (after !== null) {
    const page = await tasks.history(workspaceId, owner.userId, binding.task_id, { after, limit: 100 });
    if (execute)
      for (const message of page.messages) await tasks.checkSources(workspaceId, owner.userId, message.sources, runId);
    after = page.nextCursor;
  }
  const githubContext = await githubTaskContext(tx, binding.task_id);
  const rows = z
    .array(z.object({ call: toolCallSchema, result: toolResultSchema }))
    .parse(
      (
        await tx.client.query(
          `SELECT c.call,c.result FROM ${relation(tx, 'tf_agent_tool_calls')} c JOIN ${relation(tx, 'tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 AND b.generation>=$2`,
          [binding.task_id, githubContext.generation],
        )
      ).rows,
    );
  for (const row of rows) {
    const github = githubTaskResultSchema.safeParse(row.result);
    if (github.success)
      await requireDraftSources(tx, owner, github.data.sources, new Set(), execute ? runId : undefined);
    if (row.call.tool === 'github.issue.read' || row.call.tool.startsWith('google.'))
      throw new TaskApprovalError('task-read-unsupported');
    const resources =
      'tableId' in row.call
        ? [row.call.tableId]
        : row.call.tool === 'tables.list' && row.result && typeof row.result === 'object' && 'tables' in row.result
          ? row.result.tables.map(item => item.id)
          : [];
    for (const tableId of resources) {
      await requireTablePermission(tx, owner, tableId, 'table.row.read');
      if (execute) await requireTablePermission(tx, { kind: 'agent', runId }, tableId, 'table.row.read');
    }
  }
  return owner;
}
export async function actionAuthority(
  tx: AgentTransaction,
  owner: HumanActor,
  runId: string,
  action: z.infer<typeof taskActionSchema>,
) {
  await requireNoMcpDerived(tx, [], { kind: 'agent', runId });
  const permission =
    action.call.tool === 'rows.create'
      ? 'table.row.create'
      : action.call.tool === 'rows.update'
        ? 'table.row.update'
        : 'table.row.delete';
  for (const actor of [owner, { kind: 'agent' as const, runId }]) {
    await requireTablePermission(tx, actor, action.call.tableId, 'table.row.read');
    await requireTablePermission(tx, actor, action.call.tableId, permission);
    if (action.after) await requireAgentRecordFiles(tx, actor, action.after.values, action.before?.values ?? null);
    for (const value of Object.values(action.after?.values ?? {}))
      if (value && typeof value === 'object' && value.kind === 'relationship')
        await requireTablePermission(tx, actor, value.tableId, 'table.row.read');
  }
}
export async function actionFresh(
  tx: AgentTransaction & { commonVersion: number },
  workspaceId: string,
  runId: string,
  action: z.infer<typeof taskActionSchema>,
) {
  try {
    const current = await createAgentRecordTools(boundRuntime(tx, workspaceId)).recordSnapshot(
      workspaceId,
      { kind: 'agent', runId },
      action.call.tableId,
      action.call.expectedAppliedRevision,
      action.recordId,
    );
    if (current.token !== action.token || canonicalJson(current.record) !== canonicalJson(action.before))
      throw new TaskApprovalError('stale-proposal');
  } catch (error) {
    if (error instanceof TableError || error instanceof GenerationError) throw new TaskApprovalError('stale-proposal');
    throw error;
  }
}
export async function admitTaskCall(tx: AgentTransaction, taskId: string, callId: string) {
  if (
    (await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_task_tool_usage')} WHERE call_id=$1`, [callId]))
      .rowCount
  )
    return true;
  const charged = await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_tasks')} SET tool_calls=tool_calls+1 WHERE id=$1 AND tool_calls<(limits->>'toolCalls')::integer AND active_milliseconds<(limits->>'activeMilliseconds')::bigint RETURNING id`,
    [taskId],
  );
  if (!charged.rowCount) {
    const changed = await tx.client.query(
      `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status='paused',pause_reason=CASE WHEN tool_calls>=(limits->>'toolCalls')::integer THEN 'limit.toolCalls' ELSE 'limit.activeTime' END WHERE id=$1 AND status IS DISTINCT FROM 'paused'`,
      [taskId],
    );
    taskTransition(tx, 'paused', changed.rowCount);
    return false;
  }
  await tx.client.query(`INSERT INTO ${relation(tx, 'tf_agent_task_tool_usage')} (call_id,task_id) VALUES ($1,$2)`, [
    callId,
    taskId,
  ]);
  return true;
}
export async function taskActionEligibility(
  tx: AgentTransaction,
  owner: HumanActor,
  runId: string,
  callId: string,
  call: ToolCall,
  completed: boolean,
) {
  const row = (
    await tx.client.query(
      `SELECT p.id FROM ${relation(tx, 'tf_agent_task_proposals')} p WHERE p.run_id=$1 AND p.actions @> $2::jsonb`,
      [runId, JSON.stringify([{ id: callId }])],
    )
  ).rows[0];
  if (!row) throw new TaskApprovalError('approval-required');
  const proposal = await loadTaskProposal(tx, z.uuid().parse(row.id));
  const action = proposal.actions.find(action => action.id === callId);
  if (!action || canonicalJson(action.call) !== canonicalJson(call)) throw new TaskApprovalError('proposal-conflict');
  await actionAuthority(tx, owner, runId, action);
  const receipt = (
    await tx.client.query(`SELECT status FROM ${relation(tx, 'tf_agent_task_action_receipts')} WHERE call_id=$1`, [
      callId,
    ])
  ).rows[0];
  if (receipt && (!completed || receipt.status !== 'completed')) throw new TaskApprovalError('proposal-conflict');
  if (completed) {
    if (!receipt) throw new TaskApprovalError('proposal-conflict');
    return 'completed' as const;
  }
  const stored = z
    .object({ status: z.enum(['pending', 'completed', 'waiting', 'blocked', 'failed']) })
    .parse(
      (
        await tx.client.query(
          `SELECT status FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=$1 AND run_id=$2 AND call=$3::jsonb FOR UPDATE`,
          [callId, runId, canonicalJson(action.call)],
        )
      ).rows[0],
    );
  if (stored.status === 'failed' || stored.status === 'blocked') return stored.status;
  if (stored.status !== 'pending') throw new TaskApprovalError('proposal-conflict');
  if (
    (
      await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_task_supersessions')} WHERE proposal_id=$1`, [
        proposal.id,
      ])
    ).rowCount
  )
    throw new TaskApprovalError('proposal-conflict');
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_agent_task_decisions')} WHERE proposal_id=$1 AND digest=$2 AND membership_id=$3 AND decision='approve'`,
        [proposal.id, proposal.digest, owner.membershipId],
      )
    ).rowCount
  )
    throw new TaskApprovalError('approval-required');
  for (const previous of proposal.actions) {
    if (previous.id === callId) break;
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_agent_task_action_receipts')} WHERE call_id=$1 AND status='completed'`,
          [previous.id],
        )
      ).rowCount
    )
      return 'waiting' as const;
  }
  return action;
}
export async function executeTaskCall(
  tx: AgentTransaction & { commonVersion: number },
  workspaceId: string,
  runId: string,
  callId: string,
  call: ToolCall,
  completed: boolean,
  activity: TaskWork | null = null,
  parallel = false,
) {
  const binding = await taskRun(tx, runId);
  if (!binding) return false;
  if (!parallel) await lockTask(tx, binding.task_id);
  if (call.tool === 'github.issue.read' || call.tool.startsWith('google.'))
    throw new TaskApprovalError('task-read-unsupported');
  const owner = await taskOutputAllowed(tx, workspaceId, runId, !completed);
  const action = ['rows.create', 'rows.update', 'rows.delete'].includes(call.tool)
    ? await taskActionEligibility(tx, owner, runId, callId, call, completed)
    : null;
  if (typeof action === 'string') return action;
  if (!completed && !activity && !(await admitTaskCall(tx, binding.task_id, callId))) return 'waiting';
  if (!action) return true;
  await actionFresh(tx, workspaceId, runId, action);
  // Proposals stored before read tokens carry no expectedToken; admission names the pinned token that is written.
  const admitted = action.call.tool === 'rows.create' ? action.call : { ...action.call, expectedToken: action.token };
  return withTaskMutation(
    { ...tx, workspaceId },
    { workspaceId, runId, recordId: action.recordId, call: admitted },
    async capability => {
      const resources = createAgentRecordTools(boundRuntime(tx, workspaceId), capability);
      const actor = { kind: 'agent' as const, runId };
      const approved = action.call;
      let result;
      switch (approved.tool) {
        case 'rows.create':
          result = await resources.createRecord(
            workspaceId,
            actor,
            approved.tableId,
            approved.expectedAppliedRevision,
            approved.values,
            action.recordId,
          );
          break;
        case 'rows.update':
          result = await resources.updateRecord(
            workspaceId,
            actor,
            approved.tableId,
            approved.expectedAppliedRevision,
            approved.recordId,
            approved.values,
            action.token,
          );
          break;
        case 'rows.delete':
          result = await resources.deleteRecord(
            workspaceId,
            actor,
            approved.tableId,
            approved.expectedAppliedRevision,
            approved.recordId,
            action.token,
          );
          break;
      }
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status='completed',result=$2 WHERE id=$1`,
        [callId, JSON.stringify(toolResultSchema.parse(result))],
      );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,'completed')`,
        [callId],
      );
      await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status='running' WHERE id=$1`, [runId]);
      return 'completed' as const;
    },
  );
}
