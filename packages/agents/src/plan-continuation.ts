import { z } from 'zod';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import type { ConversationPlanning, ReplyFence } from '@tulipfarm/conversations/runtime';
import { relation, type AgentTransaction } from './store.ts';
import {
  createAgentPlans,
  notifyPlanChange,
  planCompatibility,
  loadTasks,
  toNode,
  pausePlanWork,
  persist,
} from './plans.ts';
import { planLifecycleSchema } from './plan-contracts.ts';
import { boundRuntime } from './task-approval-gate.ts';

type Transaction = AgentTransaction & { commonVersion: number };

async function activePlan(tx: Transaction, fence: ReplyFence, linked: boolean) {
  if (tx.commonVersion < planCompatibility.minimum) return null;
  const actor = await turnRequester(tx, fence.conversationId, fence.turnId);
  return z
    .object({ id: z.uuid(), version: z.number().int(), lifecycle: planLifecycleSchema })
    .nullable()
    .parse(
      (
        await tx.client.query(
          `SELECT id,version,lifecycle FROM ${relation(tx, 'tf_agent_plans')} p
      WHERE conversation_id=$1 AND starter_membership_id=$2 AND planning IS NOT NULL
        AND (NOT $4 OR source_turn_id=$3 OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} t WHERE t.id=$3 AND t.plan_id=p.id)
          OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} a WHERE a.plan_id=p.id AND a.turn_id=$3 AND a.coordinator))
      ORDER BY created_at DESC,id DESC LIMIT 1 ${linked ? 'FOR UPDATE' : ''}`,
          [fence.conversationId, actor.membershipId, fence.turnId, linked],
        )
      ).rows[0] ?? null,
    );
}

export const coordinatorContext: NonNullable<ConversationPlanning['context']> = async (tx, fence) => {
  const plan = await activePlan(tx, fence, false);
  if (!plan || !['draft', 'active', 'paused'].includes(plan.lifecycle)) return null;
  const actor = await turnRequester(tx, fence.conversationId, fence.turnId);
  const view = await createAgentPlans(boundRuntime(tx, fence.workspaceId)).read(
    fence.workspaceId,
    actor.userId,
    plan.id,
  );
  const attempt =
    (
      await tx.client.query(
        `SELECT id AS "attemptId",task_key AS task FROM ${relation(tx, 'tf_agent_plan_attempts')}
    WHERE plan_id=$1 AND turn_id=$2 AND coordinator AND settled_at IS NULL`,
        [plan.id, fence.turnId],
      )
    ).rows[0] ?? null;
  return `Existing saved plan and main-agent claim. Continue the same plan when this request asks to act on it; a changed user request takes priority. Plan-only mode never permits execution. Claim ready work with plans.claim, use normal tools, and submit plans.report with fresh receipt evidence. Do not say the request is complete until final verification passes.\n${JSON.stringify({ plan: view, attempt })}`;
};

export const continueCoordinator: NonNullable<ConversationPlanning['finish']> = async (tx, fence) => {
  const plan = await activePlan(tx, fence, true);
  if (!plan || plan.lifecycle === 'draft' || plan.lifecycle === 'completed') return { kind: 'complete' };
  if (plan.lifecycle !== 'active')
    return {
      kind: 'complete',
      text: `The plan is ${plan.lifecycle}. Its remaining requirements are not complete. Review the plan before continuing.`,
    };
  const state = z
    .object({
      calls: z.number().int(),
      previous: z.number().int(),
      slices: z.number().int(),
      incomplete: z.boolean(),
      newer: z.boolean(),
      ready: z.boolean(),
      workers: z.boolean(),
    })
    .parse(
      (
        await tx.client.query(
          `SELECT
      (SELECT count(*)::integer FROM ${relation(tx, 'tf_conversation_tool_calls')} WHERE turn_id=t.id) AS calls,
      t.planning_sequence AS previous,t.planning_slices AS slices,
      EXISTS (SELECT 1 FROM ${relation(tx, 'tf_conversation_tool_calls')} c LEFT JOIN ${relation(tx, 'tf_conversation_execution_steps')} s ON s.call_id=c.id
        WHERE c.turn_id=t.id AND (c.status='running' OR s.output IS NULL)) AS incomplete,
      EXISTS (SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} n WHERE n.conversation_id=t.conversation_id AND n.accepted_sequence>t.accepted_sequence) AS newer,
      EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_tasks')} w WHERE w.plan_id=$2
        AND (w.state='verifying' OR w.coordinator AND w.state IN ('ready','running','failed'))) AS ready,
      (EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} a WHERE a.plan_id=$2 AND NOT a.coordinator AND a.settled_at IS NULL)
        OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_tasks')} w WHERE w.plan_id=$2 AND w.kind='work' AND NOT w.coordinator AND w.state='ready')) AS workers
      FROM ${relation(tx, 'tf_conversation_turns')} t WHERE t.id=$1`,
          [fence.turnId, plan.id],
        )
      ).rows[0],
    );
  if (state.ready && !state.newer && !state.incomplete && state.calls > state.previous && state.slices < 100) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_conversation_turns')} SET status='queued',generation=generation+1,
      attempts=0,lease_until=NULL,retry_at=NULL,planning_slices=planning_slices+1,planning_sequence=$2 WHERE id=$1`,
      [fence.turnId, state.calls],
    );
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_conversation_outbox')} (turn_id,conversation_id,generation)
      SELECT id,conversation_id,generation FROM ${relation(tx, 'tf_conversation_turns')} WHERE id=$1`,
      [fence.turnId],
    );
    return { kind: 'continue' };
  }
  if (state.workers && !state.ready && !state.newer && !state.incomplete) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL,error_code='plan-worker-waiting',attempts=0 WHERE id=$1`,
      [fence.turnId],
    );
    return { kind: 'continue' };
  }
  const version = plan.version + 1;
  const before = (await loadTasks(tx, plan.id)).map(toNode),
    nodes = before.map(node => ({ ...node }));
  await pausePlanWork(tx, plan.id, nodes);
  const changes = await persist(tx, plan.id, version, new Map(before.map(node => [node.key, node])), nodes);
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_plans')} SET lifecycle='paused',version=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [plan.id, version],
  );
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_agent_plan_events')} (plan_id,version,actor,kind,changes)
    VALUES ($1,$2,'coordinator','advanced',$3)`,
    [plan.id, version, JSON.stringify([...changes, { op: 'lifecycle', to: 'paused', reason: 'progress' }])],
  );
  await notifyPlanChange(tx, fence.workspaceId, { id: plan.id, chatId: fence.conversationId });
  return {
    kind: 'complete',
    text: state.newer
      ? 'The plan is paused for your newer message. Completed actions were kept; the remaining requirements are not complete.'
      : state.incomplete
        ? 'The plan is paused because an action has no confirmed result. Check its existing receipt before retrying; do not repeat the action.'
        : 'The plan is paused. Remaining work needs a decision, a prerequisite, or a checked worker result. Review the plan before continuing.',
  };
};
