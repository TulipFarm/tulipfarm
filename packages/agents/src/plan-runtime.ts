import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  AccessDenied,
  deferRemoteSourceChecks,
  lockAuthorization,
  withRemoteSourceCheckBudget,
  requireTaskInvocation,
  resolveHuman,
  SourceAuthorizationUnavailable,
  uuidSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { sourceDependencySchema, type SourceDependency } from '@tulipfarm/access/source-dependencies';
import { authorizeChat } from '@tulipfarm/conversations/chat-access';
import { ConversationConflict } from '@tulipfarm/conversations/contracts';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { knowledgeTaskSpend } from '@tulipfarm/workspace-storage/knowledge-credits';
import { creditUnitsForProviderCost, reserveCredits } from '@tulipfarm/workspace-storage/credits';
import { maximumTaskLimits } from './contracts.ts';
import {
  advancePlan,
  applyPlanningPrerequisites,
  planBudgetSchema,
  planLifecycleSchema,
  planSpecificationSchema,
  planLimits,
  PlanGraphError,
  specialistInputSchema,
  summarizePlan,
  AgentPlanError,
  coordinatorOriginSchema,
  planClaimSchema,
  planSubmitReportSchema,
  validatePlanReport,
  type CoordinatorOrigin,
  type PlanNode,
  type PlanTaskState,
  type PlanWorkerReport,
} from './plan-contracts.ts';
import { requirePlanEvidence } from './plan-evidence.ts';
import {
  loadTasks,
  notifyPlanChange,
  pausePlanWork,
  ownerEndedPause,
  persist,
  planCompatibility,
  toNode,
  wakePlanWait,
} from './plans.ts';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentTaskError } from './task-contracts.ts';
import type { createAgentTasks } from './tasks.ts';
import { taskTransition } from './task-telemetry.ts';
import type { ReplyFence } from '@tulipfarm/conversations/runtime';
import { requireDraftSources } from './draft-sources.ts';

const creditUnit = 1000000000000n;
class AttemptClosed extends Error {}
/** A specialist renews its lease on every model step. A lapsed lease frees the slot and retries the task. */
export const specialistLeaseMilliseconds = 120000;
/** Ceilings for one specialist attempt. The plan budget may narrow each one further. */
export const specialistAttemptLimits = { toolCalls: 16, activeMilliseconds: 600000 } as const;
/** A task gets this many attempts before it fails; a failed task blocks only the work that depends on it. */
export const planTaskAttempts = 3;
/**
 * How long the step waits before rereading a saved agent's task whose sources couldn't be checked: as long as they
 * have been unavailable, between `minimumSeconds` and `maximumSeconds`. Once that is `pauseSeconds` or more, the plan
 * pauses for attention instead of checking again.
 */
export const sourceCheckBackoff = { minimumSeconds: 30, maximumSeconds: 1800, pauseSeconds: 3600 } as const;
const minimumAllowance = { toolCalls: 1, activeMilliseconds: 1000, credits: 1 } as const;

const allowanceSchema = z.strictObject({
  toolCalls: z.number().int().nonnegative(),
  activeMilliseconds: z.number().int().nonnegative(),
  credits: z.number().int().nonnegative(),
});
export type PlanAllowance = z.infer<typeof allowanceSchema>;
const planSchema = z.object({
  id: uuidSchema,
  chatId: uuidSchema,
  starterUserId: z.string(),
  starterMembershipId: uuidSchema,
  lifecycle: planLifecycleSchema,
  planning: planSpecificationSchema.nullable(),
  version: z.number().int().nonnegative(),
  budget: planBudgetSchema,
  toolCalls: z.number().int().nonnegative(),
  activeMilliseconds: z.coerce.number().int().nonnegative(),
});
type Plan = z.infer<typeof planSchema>;
const planColumns = `id, conversation_id AS "chatId", starter_user_id AS "starterUserId", starter_membership_id AS "starterMembershipId", lifecycle, planning, version, budget, tool_calls AS "toolCalls", active_milliseconds AS "activeMilliseconds"`;
const attemptSchema = z.object({
  id: uuidSchema,
  taskKey: z.string(),
  generation: z.number().int().nonnegative(),
  agentId: uuidSchema.nullable(),
  activationId: uuidSchema.nullable(),
  coordinator: z.boolean(),
  specialist: z.string().nullable(),
  status: z.enum(['running', 'waiting-input', 'waiting-approval', 'yielded', 'completed', 'failed', 'cancelled']),
  agentTaskId: uuidSchema.nullable(),
  allowance: allowanceSchema.nullable(),
  leaseExpired: z.boolean(),
  open: z.boolean(),
  toolCalls: z.number().int().nonnegative(),
  activeMilliseconds: z.coerce.number().int().nonnegative(),
  checkAfterMs: z.number().int().positive().nullable(),
});
type Attempt = z.infer<typeof attemptSchema>;
const attemptColumns = `id, task_key AS "taskKey", generation, coordinator, agent_id AS "agentId", activation_id AS "activationId", specialist_key AS specialist, status,
  agent_task_id AS "agentTaskId", allowance, COALESCE(lease_until <= clock_timestamp(), false) AS "leaseExpired", settled_at IS NULL AS open,
  tool_calls AS "toolCalls", active_milliseconds AS "activeMilliseconds",
  CASE WHEN source_check_after > clock_timestamp() THEN ceil(extract(epoch FROM source_check_after - clock_timestamp()) * 1000)::integer END AS "checkAfterMs"`;

/**
 * What a saved agent's task reported when the step last read it. Reads happen as the starter, outside the plan lock.
 * `unavailable` means its sources couldn't be checked right now, which revokes nothing.
 */
export type SavedTaskObservation =
  | { attemptId: string; status: string; result?: string }
  | { attemptId: string; failure: string }
  | { attemptId: string; unavailable: true };
/**
 * `waiting` means open attempts remain, so the step should run again later: after `retryAfterMs` when every open
 * attempt is waiting for its sources to be checked again, otherwise soon. `terminal` means nothing will change until a
 * new wake.
 */
export type PlanProgress = { kind: 'waiting' | 'terminal'; specialists: string[]; retryAfterMs?: number };
export type SpecialistAssignment = {
  attemptId: string;
  planId: string;
  chatId: string;
  generation: number;
  starterUserId: string;
  starterMembershipId: string;
  name: string;
  role: string;
  instructions: string;
  /** The family the step runs on. Without it, the plan role's model. */
  modelFamilyId?: string | undefined;
  tools: readonly string[];
  title: string;
  brief: string;
  criteria: readonly string[];
  planning: boolean;
  inputs: readonly { title: string; result: string }[];
  inputSources: readonly SourceDependency[];
  allowance: PlanAllowance;
};
export type SpecialistOutcome =
  | { kind: 'completed'; result: string; sources: readonly unknown[]; report?: PlanWorkerReport }
  | { kind: 'failed'; code: string };
const nonRetryableSpecialistFailures = new Set([
  'credits-exhausted',
  'step-not-admitted',
  'access-revoked',
  'model-unavailable',
  'model-unpriced',
  'context-overflow',
  'time-limit',
  'tool-limit',
]);

const reasons = {
  agentAccess: 'The person who started this plan can no longer use this saved agent.',
  agentInactive: 'This saved agent has no active version.',
  attemptsExhausted: `This task did not finish after ${planTaskAttempts} attempts.`,
  savedPaused: 'The saved agent paused this task at its limits.',
  savedFailed: 'The saved agent could not finish this task.',
  waitingInput: 'The saved agent asked a question in its task.',
  waitingApproval: 'The saved agent is waiting for an approval in its task.',
} as const;

function share(total: number, parts: number) {
  return Math.max(0, Math.floor(total / Math.max(1, parts)));
}

export async function coordinatorAdmission(
  tx: AgentTransaction & { commonVersion: number },
  fence: ReplyFence,
  input: { tool?: string; reserve?: bigint } = {},
) {
  return (await admitCoordinator(tx, fence, input))?.id ?? null;
}

/**
 * Admits a coordinator reply's next model call, as {@link reserveCoordinatorModel} does, and returns what remains
 * of its attempt's allowance, so the reply can enforce the budget in memory until its next database touch. Null
 * when the turn coordinates no open attempt.
 */
export async function coordinatorReplyBudget(
  tx: AgentTransaction & { commonVersion: number },
  fence: ReplyFence,
  reserve: bigint,
) {
  const admitted = await admitCoordinator(tx, fence, { reserve });
  if (!admitted) return null;
  return {
    attemptId: admitted.id,
    remainingUnits: BigInt(admitted.allowance.credits) * creditUnit - BigInt(admitted.spent),
    remainingMilliseconds: admitted.allowance.activeMilliseconds - admitted.activeMilliseconds,
  };
}

/** Adds a reply's model time to its coordinator attempt; the reply's usage rows carry the per-call share. */
export async function recordCoordinatorReplyTime(tx: AgentTransaction, attemptId: string, elapsedMilliseconds: number) {
  if (elapsedMilliseconds <= 0) return;
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET active_milliseconds=active_milliseconds+$2 WHERE id=$1`,
    [attemptId, Math.ceil(elapsedMilliseconds)],
  );
}

async function admitCoordinator(
  tx: AgentTransaction & { commonVersion: number },
  fence: ReplyFence,
  input: { tool?: string; reserve?: bigint },
) {
  if (tx.commonVersion < planCompatibility.minimum) return null;
  const binding = z
    .object({ linked: z.boolean(), lifecycle: planLifecycleSchema.nullable(), newer: z.boolean() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT p.id IS NOT NULL AS linked,p.lifecycle,
      EXISTS (SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} n
        WHERE n.conversation_id=t.conversation_id AND n.accepted_sequence>t.accepted_sequence) AS newer
      FROM ${relation(tx, 'tf_conversation_turns')} t LEFT JOIN LATERAL (
        SELECT id,lifecycle FROM ${relation(tx, 'tf_agent_plans')}
        WHERE id=t.plan_id OR source_turn_id=t.id AND execution='execute'
        ORDER BY (id=t.plan_id) DESC NULLS LAST,created_at DESC,id DESC LIMIT 1) p ON true
      WHERE t.id=$1 AND t.conversation_id=$2 AND t.generation=$3 AND t.attempt_epoch=$4
        AND t.status='processing' AND t.lease_until>clock_timestamp()`,
          [fence.turnId, fence.conversationId, fence.generation, fence.epoch],
        )
      ).rows[0],
    );
  if (!binding || (binding.newer && (binding.linked || input.tool?.startsWith('plans.')))) throw new AccessDenied();
  if (
    binding.linked &&
    binding.lifecycle !== 'active' &&
    binding.lifecycle !== 'completed' &&
    input.tool !== 'plans.read'
  )
    throw new AccessDenied();
  const row = z
    .object({
      id: uuidSchema,
      planId: uuidSchema,
      lifecycle: planLifecycleSchema,
      turnGeneration: z.number().int(),
      turnEpoch: z.number().int(),
      open: z.boolean(),
      status: z.string(),
      allowance: allowanceSchema,
      toolCalls: z.number().int(),
      activeMilliseconds: z.coerce.number(),
      spent: z.string(),
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT a.id,a.plan_id AS "planId",p.lifecycle,a.turn_generation AS "turnGeneration",a.turn_epoch AS "turnEpoch",
    a.settled_at IS NULL AS open,a.status,a.allowance,
    (SELECT count(*)::integer FROM ${relation(tx, 'tf_conversation_tool_calls')} c
      WHERE c.turn_id=a.turn_id AND c.sequence>a.claim_sequence AND c.tool NOT LIKE 'plans.%') AS "toolCalls",
    a.active_milliseconds AS "activeMilliseconds",
    (SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text FROM ${relation(tx, 'tf_credit_usage')} WHERE plan_attempt_id=a.id) AS spent
    FROM ${relation(tx, 'tf_agent_plan_attempts')} a JOIN ${relation(tx, 'tf_agent_plans')} p ON p.id=a.plan_id
    WHERE a.turn_id=$1 AND a.coordinator ORDER BY a.created_at DESC,a.id DESC LIMIT 1 FOR UPDATE OF p,a`,
          [fence.turnId],
        )
      ).rows[0],
    );
  if (!row) return null;
  if (row.status === 'cancelled' && input.tool !== 'plans.read') throw new AccessDenied();
  if (!row.open && row.lifecycle === 'completed') return null;
  if (row.lifecycle !== 'active' && input.tool !== 'plans.read') throw new AccessDenied();
  if (!row.open) return null;
  if (row.turnGeneration > fence.generation) throw new AccessDenied();
  const turn = await tx.client.query(
    `SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')}
    WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND attempt_epoch=$4 AND status='processing' AND lease_until>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} n WHERE n.conversation_id=$2
        AND n.accepted_sequence>(SELECT accepted_sequence FROM ${relation(tx, 'tf_conversation_turns')} WHERE id=$1))`,
    [fence.turnId, fence.conversationId, fence.generation, fence.epoch],
  );
  if (!turn.rowCount) throw new AccessDenied();
  if (row.turnEpoch !== fence.epoch || row.turnGeneration !== fence.generation)
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET turn_epoch=$2,turn_generation=$3 WHERE id=$1`,
      [row.id, fence.epoch, fence.generation],
    );
  await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET tool_calls=$2 WHERE id=$1`, [
    row.id,
    row.toolCalls,
  ]);
  if (
    !input.tool?.startsWith('plans.') &&
    ((input.tool !== undefined && row.toolCalls > row.allowance.toolCalls) ||
      row.activeMilliseconds >= row.allowance.activeMilliseconds ||
      BigInt(row.spent) + creditUnitsForProviderCost(input.reserve ?? 0n) > BigInt(row.allowance.credits) * creditUnit)
  ) {
    throw new PlanGraphError('planning-budget');
  }
  return row;
}

export async function reserveCoordinatorModel(
  tx: AgentTransaction & { commonVersion: number },
  fence: ReplyFence,
  input: Omit<Parameters<typeof reserveCredits>[1], 'flowId'>,
) {
  const attemptId = await coordinatorAdmission(tx, fence, { reserve: BigInt(input.providerPicoUsd) });
  const admitted = await reserveCredits(tx, { ...input, flowId: fence.conversationId });
  if (admitted && attemptId)
    await tx.client.query(`UPDATE ${relation(tx, 'tf_credit_usage')} SET plan_attempt_id=$2 WHERE id=$1`, [
      input.id,
      attemptId,
    ]);
  return { admitted, attemptId };
}

export async function recordCoordinatorModelTime(
  tx: AgentTransaction,
  usageId: string,
  attemptId: string,
  elapsedMilliseconds: number,
) {
  await tx.client.query(
    `WITH recorded AS (
    UPDATE ${relation(tx, 'tf_credit_usage')} SET plan_milliseconds=$3
    WHERE id=$1 AND plan_attempt_id=$2 AND plan_milliseconds IS NULL RETURNING plan_attempt_id)
    UPDATE ${relation(tx, 'tf_agent_plan_attempts')} a SET active_milliseconds=active_milliseconds+$3
    FROM recorded WHERE a.id=recorded.plan_attempt_id`,
    [usageId, attemptId, Math.ceil(elapsedMilliseconds)],
  );
}

export function createPlanRuntime(
  runtime: AgentStorage,
  tasks?: Pick<ReturnType<typeof createAgentTasks>, 'startForWorkflow' | 'readResult'>,
) {
  function system<T>(workspaceId: string, operation: (tx: AgentTransaction) => Promise<T>) {
    return runtime.transaction(uuidSchema.parse(workspaceId), planCompatibility, async tx => {
      // Plans never change grants, so a shared lock is enough to see a consistent authorization state.
      await lockAuthorization(tx, 'read');
      return operation(tx);
    });
  }
  async function loadPlan(tx: AgentTransaction, planId: string, lock: boolean) {
    return planSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT ${planColumns} FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
            [uuidSchema.parse(planId)],
          )
        ).rows[0],
      );
  }
  async function loadAttempts(tx: AgentTransaction, planId: string, open: boolean) {
    return z
      .array(attemptSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT ${attemptColumns} FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE plan_id=$1 ${open ? 'AND settled_at IS NULL' : ''} ORDER BY created_at, id`,
            [planId],
          )
        ).rows,
      );
  }
  /** The starter's current membership and chat access. A plan acts only while its starter could still start it. */
  async function starter(tx: AgentTransaction, plan: Plan): Promise<HumanActor | null> {
    try {
      const actor = await resolveHuman(tx, plan.starterUserId);
      if (actor.membershipId !== plan.starterMembershipId) return null;
      const chat = z
        .object({ owner: z.boolean(), projectId: uuidSchema.nullable() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT (owner_user_id=$2 AND owner_membership_id=$3) AS owner, project_id AS "projectId"
        FROM ${relation(tx, 'tf_conversations')} WHERE id=$1 AND kind='private' AND deleted_at IS NULL`,
              [plan.chatId, actor.userId, actor.membershipId],
            )
          ).rows[0],
        );
      if (!chat) return null;
      await authorizeChat(tx, actor, chat, 'turn');
      return actor;
    } catch (error) {
      if (error instanceof AccessDenied || error instanceof ConversationConflict) return null;
      throw error;
    }
  }
  /** Credits charged or held on one flow, in provider picodollars. */
  async function flowSpend(tx: AgentTransaction, flowId: string) {
    const row = z
      .object({ amount: z.string() })
      .parse(
        (
          await tx.client.query(
            `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS amount FROM ${relation(tx, 'tf_credit_usage')} WHERE flow_id=$1`,
            [flowId],
          )
        ).rows[0],
      );
    return BigInt(row.amount) + (await knowledgeTaskSpend(tx, flowId));
  }
  /** Each attempt spends from its own flow: a specialist from its attempt ID, a saved agent from its task's flow. */
  async function attemptFlow(tx: AgentTransaction, attempt: Attempt) {
    if (attempt.specialist) return attempt.id;
    if (!attempt.agentTaskId) return null;
    return z
      .string()
      .parse(
        (
          await tx.client.query(`SELECT flow_id FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1`, [
            attempt.agentTaskId,
          ])
        ).rows[0]?.flow_id,
      );
  }
  /**
   * Budget already used or promised. Settled attempts count what they used. Open attempts count the larger of their
   * allowance and their use, because they may still spend up to their allowance.
   */
  async function committed(tx: AgentTransaction, attempts: readonly Attempt[]) {
    let credits = 0n,
      toolCalls = 0,
      activeMilliseconds = 0;
    for (const attempt of attempts) {
      const flow = await attemptFlow(tx, attempt);
      const spent = attempt.coordinator
        ? BigInt(
            z.string().parse(
              (
                await tx.client.query(
                  `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS spent
          FROM ${relation(tx, 'tf_credit_usage')} WHERE plan_attempt_id=$1`,
                  [attempt.id],
                )
              ).rows[0]?.spent,
            ),
          )
        : flow
          ? await flowSpend(tx, flow)
          : 0n;
      const allowance = attempt.open
        ? (attempt.allowance ?? { toolCalls: 0, activeMilliseconds: 0, credits: 0 })
        : { toolCalls: 0, activeMilliseconds: 0, credits: 0 };
      const held = BigInt(allowance.credits) * creditUnit;
      credits += spent > held ? spent : held;
      toolCalls += Math.max(allowance.toolCalls, attempt.toolCalls);
      activeMilliseconds += Math.max(allowance.activeMilliseconds, attempt.activeMilliseconds);
    }
    return { credits, toolCalls, activeMilliseconds };
  }
  async function settle(
    tx: AgentTransaction,
    attemptId: string,
    status: 'yielded' | 'completed' | 'failed' | 'cancelled',
    fields: {
      result?: string;
      failure?: string;
      sources?: readonly unknown[];
      liveSpecialist?: boolean;
      usage?: { toolCalls: number; activeMilliseconds: number };
    } = {},
  ) {
    return (
      (
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET status=$2, result=$3, failure_code=$4, sources=$5, lease_until=NULL, settled_at=clock_timestamp(),
      tool_calls=GREATEST(tool_calls,$6), active_milliseconds=GREATEST(active_milliseconds,$7) WHERE id=$1 AND settled_at IS NULL ${fields.liveSpecialist ? 'AND lease_until>clock_timestamp()' : ''}`,
          [
            attemptId,
            status,
            fields.result?.slice(0, 16000) ?? null,
            fields.failure ?? null,
            JSON.stringify(fields.sources ?? []),
            fields.usage?.toolCalls ?? 0,
            fields.usage?.activeMilliseconds ?? 0,
          ],
        )
      ).rowCount === 1
    );
  }
  /** Failed attempts of a task. Attempts cancelled by a pause do not count. */
  async function failures(tx: AgentTransaction, planId: string, taskKey: string) {
    return z.coerce
      .number()
      .int()
      .parse(
        (
          await tx.client.query(
            `SELECT count(*) AS failed FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE plan_id=$1 AND task_key=$2 AND status='failed'`,
            [planId, taskKey],
          )
        ).rows[0]?.failed,
      );
  }
  /** Saved tasks record their own usage. The attempt copies it so plan totals stay correct after the task ends. */
  async function savedUsage(tx: AgentTransaction, taskId: string) {
    return z
      .object({ toolCalls: z.number().int(), activeMilliseconds: z.coerce.number().int() })
      .parse(
        (
          await tx.client.query(
            `SELECT tool_calls AS "toolCalls", active_milliseconds AS "activeMilliseconds" FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1`,
            [taskId],
          )
        ).rows[0],
      );
  }
  async function liveActivation(tx: AgentTransaction, agentId: string) {
    return z
      .object({ id: uuidSchema, revision: z.string() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT id, definition_revision AS revision FROM ${relation(tx, 'tf_agent_activations')}
      WHERE agent_id=$1 AND revoked_at IS NULL ORDER BY activated_at DESC NULLS LAST, id DESC LIMIT 1`,
            [agentId],
          )
        ).rows[0],
      );
  }

  /**
   * One scheduling pass under the plan lock: settle what workers reported, stop at the budget or a lost starter,
   * release work whose prerequisites completed, and claim ready work up to the worker limit.
   */
  // Advancing only reads sources, so remote source checks run between its retried transactions, not inside them.
  async function advance(workspaceId: string, planId: string, observations: readonly SavedTaskObservation[] = []) {
    return deferRemoteSourceChecks(() => advanceOnce(workspaceId, planId, observations));
  }
  async function advanceOnce(workspaceId: string, planId: string, observations: readonly SavedTaskObservation[]) {
    return system(workspaceId, async tx => {
      await tx.client.query(
        `SELECT c.id FROM ${relation(tx, 'tf_conversations')} c JOIN ${relation(tx, 'tf_agent_plans')} p ON p.conversation_id=c.id WHERE p.id=$1 FOR UPDATE OF c`,
        [planId],
      );
      const plan = await loadPlan(tx, planId, true);
      if (!plan)
        return { progress: { kind: 'terminal', specialists: [] } satisfies PlanProgress, starts: [] as string[] };
      const rows = await loadTasks(tx, plan.id);
      const before = new Map(rows.map(row => [row.key, toNode(row)]));
      const nodes = new Map(
        applyPlanningPrerequisites(rows.map(toNode), plan.planning ?? undefined).map(node => [node.key, node]),
      );
      const lifecycleChanges: unknown[] = [];
      let lifecycle = plan.lifecycle;
      const setState = (key: string, state: PlanTaskState, reason: string | null) => {
        const node = nodes.get(key);
        if (node && node.kind === 'work') {
          node.state = state;
          node.reason = reason;
        }
      };
      const reported = new Map(observations.map(item => [item.attemptId, item]));
      for (const attempt of await loadAttempts(tx, plan.id, true)) {
        if (attempt.coordinator) {
          const turn = z
            .object({ status: z.string(), error: z.string().nullable() })
            .parse(
              (
                await tx.client.query(
                  `SELECT t.status,t.error_code AS error FROM ${relation(tx, 'tf_conversation_turns')} t JOIN ${relation(tx, 'tf_agent_plan_attempts')} a ON a.turn_id=t.id WHERE a.id=$1`,
                  [attempt.id],
                )
              ).rows[0],
            );
          if (['completed', 'cancelled', 'failed', 'blocked'].includes(turn.status)) {
            await settle(tx, attempt.id, 'cancelled', { failure: 'turn-ended' });
            setState(
              attempt.taskKey,
              'verifying',
              'The reply stopped. Check existing action results before continuing.',
            );
            if (lifecycle === 'active') {
              lifecycle = 'paused';
              lifecycleChanges.push({
                op: 'lifecycle',
                to: 'paused',
                reason: turn.error === 'plan-budget' ? 'budget' : 'progress',
              });
            }
          }
          continue;
        }
        if (attempt.specialist) {
          if (attempt.status !== 'running' || !attempt.leaseExpired) continue;
          await settle(tx, attempt.id, 'failed', { failure: 'lease-expired' });
          const exhausted = (await failures(tx, plan.id, attempt.taskKey)) >= planTaskAttempts;
          setState(attempt.taskKey, exhausted ? 'failed' : 'pending', exhausted ? reasons.attemptsExhausted : null);
          continue;
        }
        const observed = reported.get(attempt.id);
        if (!observed || !attempt.agentTaskId) continue;
        if ('unavailable' in observed) {
          if ((await sourcesUnavailable(tx, attempt.id)) && lifecycle === 'active') {
            await pausePlanWork(tx, plan.id, [...nodes.values()]);
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET source_check_after=NULL, sources_unavailable_since=NULL WHERE plan_id=$1 AND settled_at IS NULL`,
              [plan.id],
            );
            lifecycle = 'paused';
            lifecycleChanges.push({ op: 'lifecycle', to: 'paused', reason: 'sources-unavailable' });
          }
          continue;
        }
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET source_check_after=NULL, sources_unavailable_since=NULL WHERE id=$1 AND sources_unavailable_since IS NOT NULL`,
          [attempt.id],
        );
        if ('failure' in observed) {
          await settle(tx, attempt.id, 'failed', {
            failure: observed.failure,
            usage: await savedUsage(tx, attempt.agentTaskId),
          });
          setState(attempt.taskKey, 'failed', reasons.agentAccess);
          continue;
        }
        const usage = await savedUsage(tx, attempt.agentTaskId);
        switch (observed.status) {
          case 'completed':
            await settle(tx, attempt.id, 'completed', { result: observed.result ?? '', usage });
            setState(
              attempt.taskKey,
              plan.planning ? 'verifying' : 'completed',
              plan.planning ? 'The main agent must check this report against the task criteria.' : null,
            );
            break;
          case 'failed':
          case 'paused':
            await settle(tx, attempt.id, 'failed', {
              failure: observed.status === 'paused' ? 'saved-task-paused' : 'saved-task-failed',
              usage,
            });
            setState(
              attempt.taskKey,
              'failed',
              observed.status === 'paused' ? reasons.savedPaused : reasons.savedFailed,
            );
            break;
          case 'waiting-clarification':
          case 'waiting-approval': {
            const status = observed.status === 'waiting-approval' ? 'waiting-approval' : 'waiting-input';
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET status=$2 WHERE id=$1 AND settled_at IS NULL`,
              [attempt.id, status],
            );
            setState(
              attempt.taskKey,
              status,
              status === 'waiting-approval' ? reasons.waitingApproval : reasons.waitingInput,
            );
            break;
          }
          default:
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET status='running' WHERE id=$1 AND settled_at IS NULL`,
              [attempt.id],
            );
            setState(attempt.taskKey, 'running', null);
        }
      }
      if (
        lifecycle === 'active' &&
        plan.planning &&
        (
          await tx.client.query(
            `SELECT 1
        FROM ${relation(tx, 'tf_conversation_turns')} n WHERE n.conversation_id=$1 AND n.accepted_sequence>(
          SELECT max(t.accepted_sequence) FROM ${relation(tx, 'tf_conversation_turns')} t
          WHERE t.conversation_id=$1 AND (t.plan_id=$2 OR t.id=(SELECT source_turn_id FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$2)
            OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} a WHERE a.plan_id=$2 AND a.turn_id=t.id)))
        LIMIT 1`,
            [plan.chatId, plan.id],
          )
        ).rowCount
      ) {
        await pausePlanWork(tx, plan.id, [...nodes.values()]);
        lifecycle = 'paused';
        lifecycleChanges.push({ op: 'lifecycle', to: 'paused', reason: 'progress' });
      }
      const actor = lifecycle === 'active' ? await starter(tx, plan) : null;
      if (actor)
        for (const check of plan.planning?.prerequisites ?? []) {
          if (check.status !== 'verified' || check.optional) continue;
          try {
            await requirePlanEvidence(tx, actor, plan, check.evidence);
          } catch (error) {
            if (!(error instanceof AccessDenied) && !(error instanceof PlanGraphError)) throw error;
            // Rebuilt on every pass, so a block from a source that can't be checked right now lifts once it can.
            const block =
              error instanceof SourceAuthorizationUnavailable
                ? `Recheck ${check.title}: its evidence can't be checked right now.`
                : `Recheck ${check.title}: its evidence is no longer available.`;
            for (const key of check.tasks) {
              const node = nodes.get(key);
              if (node) {
                node.prerequisiteBlock = block;
                if (node.state === 'ready' || node.state === 'pending' || node.state === 'blocked')
                  setState(key, 'blocked', node.prerequisiteBlock);
              }
            }
          }
        }
      if (lifecycle === 'active' && !actor) {
        lifecycle = 'paused';
        lifecycleChanges.push({ op: 'lifecycle', to: 'paused', reason: 'starter-access' });
      }
      for (const change of advancePlan([...nodes.values()])) setState(change.key, change.to, change.reason);

      const open = await loadAttempts(tx, plan.id, true);
      const all = await loadAttempts(tx, plan.id, false);
      const specialists: string[] = [];
      const starts = open.filter(attempt => attempt.agentId && !attempt.agentTaskId).map(attempt => attempt.id);
      if (lifecycle === 'active' && actor) {
        const used = await committed(tx, all);
        const headroom = {
          toolCalls: plan.budget.toolCalls - used.toolCalls,
          activeMilliseconds: plan.budget.activeMilliseconds - used.activeMilliseconds,
          credits: Number((BigInt(plan.budget.credits) * creditUnit - used.credits) / creditUnit),
        };
        const slots = planLimits.workers - open.filter(attempt => attempt.status === 'running').length;
        const ready = [...nodes.values()].filter(
          node =>
            node.kind === 'work' && node.state === 'ready' && node.assignee && node.assignee.kind !== 'coordinator',
        );
        let claimed = 0;
        for (const node of ready) {
          if (claimed >= slots) break;
          const parts = Math.min(slots - claimed, ready.length - claimed);
          const allowance = {
            toolCalls: Math.min(
              share(headroom.toolCalls, parts),
              node.assignee?.kind === 'specialist' ? specialistAttemptLimits.toolCalls : maximumTaskLimits.toolCalls,
            ),
            activeMilliseconds: Math.min(
              share(headroom.activeMilliseconds, parts),
              node.assignee?.kind === 'specialist'
                ? specialistAttemptLimits.activeMilliseconds
                : maximumTaskLimits.activeMilliseconds,
            ),
            credits: Math.min(share(headroom.credits, parts), maximumTaskLimits.credits),
          };
          if (
            allowance.toolCalls < minimumAllowance.toolCalls ||
            allowance.activeMilliseconds < minimumAllowance.activeMilliseconds ||
            allowance.credits < minimumAllowance.credits
          )
            break;
          const generation = z
            .number()
            .int()
            .parse(
              (
                await tx.client.query(
                  `SELECT COALESCE(max(generation)+1,0)::integer AS next FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE plan_id=$1 AND task_key=$2`,
                  [plan.id, node.key],
                )
              ).rows[0]?.next,
            );
          const id = randomUUID();
          if (node.assignee?.kind === 'agent') {
            try {
              await requireTaskInvocation(tx, actor, node.assignee.agentId);
            } catch (error) {
              if (!(error instanceof AccessDenied)) throw error;
              setState(node.key, 'blocked', reasons.agentAccess);
              continue;
            }
            const activation = await liveActivation(tx, node.assignee.agentId);
            if (!activation) {
              setState(node.key, 'blocked', reasons.agentInactive);
              continue;
            }
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_agent_plan_attempts')} (id,plan_id,task_key,generation,agent_id,activation_id,definition_revision,allowance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [id, plan.id, node.key, generation, node.assignee.agentId, activation.id, activation.revision, allowance],
            );
            starts.push(id);
          } else if (node.assignee?.kind === 'specialist') {
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_agent_plan_attempts')} (id,plan_id,task_key,generation,specialist_key,allowance,lease_until) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+make_interval(secs => $7))`,
              [
                id,
                plan.id,
                node.key,
                generation,
                node.assignee.specialist,
                allowance,
                specialistLeaseMilliseconds / 1000,
              ],
            );
            specialists.push(id);
          }
          headroom.toolCalls -= allowance.toolCalls;
          headroom.activeMilliseconds -= allowance.activeMilliseconds;
          headroom.credits -= allowance.credits;
          setState(node.key, 'running', null);
          claimed += 1;
        }
        const stillOpen = open.length + claimed;
        if (
          ready.length > 0 &&
          claimed === 0 &&
          stillOpen === 0 &&
          slots > 0 &&
          ready.some(node => nodes.get(node.key)?.state === 'ready')
        ) {
          lifecycle = 'paused';
          lifecycleChanges.push({ op: 'lifecycle', to: 'paused', reason: 'budget' });
        }
      }
      const finalNodes = [...nodes.values()];
      const outcome = summarizePlan(finalNodes, plan.planning ?? undefined).outcome;
      const repairable =
        plan.planning &&
        outcome === 'failed' &&
        (
          await Promise.all(
            finalNodes
              .filter(node => node.kind === 'work' && node.state === 'failed')
              .map(async node => (await failures(tx, plan.id, node.key)) < planTaskAttempts),
          )
        ).some(Boolean);
      if (lifecycle === 'active' && (outcome === 'completed' || (outcome === 'failed' && !repairable))) {
        lifecycle = outcome;
        lifecycleChanges.push({ op: 'lifecycle', to: outcome });
      }
      // A planning plan is driven by the turns that own it. Once they have all ended, say a reply failed for good,
      // and no worker is left, nothing would ever continue it, so it waits for the starter to resume it.
      if (
        lifecycle === 'active' &&
        plan.planning &&
        (await loadAttempts(tx, plan.id, true)).length === 0 &&
        (await ownerEnded(tx, plan))
      ) {
        lifecycle = 'paused';
        lifecycleChanges.push(ownerEndedPause);
      }
      const version = plan.version + 1;
      const changes = [...(await persist(tx, plan.id, version, before, finalNodes)), ...lifecycleChanges];
      if (changes.length) {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plans')} SET lifecycle=$2, version=$3, updated_at=clock_timestamp() WHERE id=$1`,
          [plan.id, lifecycle, version],
        );
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_events')} (plan_id,version,actor,kind,changes) VALUES ($1,$2,'runtime','advanced',$3)`,
          [plan.id, version, JSON.stringify(changes)],
        );
        await notifyPlanChange(tx, workspaceId, plan);
      }
      const remaining = await loadAttempts(tx, plan.id, true);
      if (
        lifecycle !== 'active' ||
        remaining.length === 0 ||
        finalNodes.some(
          node =>
            node.kind === 'work' &&
            (node.state === 'verifying' || (node.assignee?.kind === 'coordinator' && node.state === 'ready')),
        )
      ) {
        await wakePlanWait(tx, plan);
      }
      const backedOff = remaining.map(attempt => attempt.checkAfterMs);
      const progress: PlanProgress = {
        kind: lifecycle === 'active' && remaining.length > 0 ? 'waiting' : 'terminal',
        specialists,
        ...(lifecycle === 'active' && backedOff.length && backedOff.every(wait => wait !== null)
          ? { retryAfterMs: Math.max(sourceCheckBackoff.minimumSeconds * 1000, Math.min(...backedOff)) }
          : {}),
      };
      return { progress, starts: lifecycle === 'active' ? starts : [] };
    });
  }

  /**
   * Records that an open saved-agent attempt's sources couldn't be checked and sets when to try again, waiting as long
   * as they have been unavailable within `sourceCheckBackoff`. Returns whether they have been unavailable long enough
   * to pause the plan.
   */
  async function sourcesUnavailable(tx: AgentTransaction, attemptId: string) {
    const row = z
      .object({ exhausted: z.boolean() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET sources_unavailable_since=COALESCE(sources_unavailable_since, clock_timestamp()),
            source_check_after=clock_timestamp() + LEAST(GREATEST(clock_timestamp() - COALESCE(sources_unavailable_since, clock_timestamp()),
              make_interval(secs => $2)), make_interval(secs => $3))
          WHERE id=$1 AND settled_at IS NULL
          RETURNING clock_timestamp() - sources_unavailable_since >= make_interval(secs => $4) AS exhausted`,
            [
              attemptId,
              sourceCheckBackoff.minimumSeconds,
              sourceCheckBackoff.maximumSeconds,
              sourceCheckBackoff.pauseSeconds,
            ],
          )
        ).rows[0],
      );
    return row?.exhausted ?? false;
  }

  /** Whether the plan has at least one owning turn and every one of them has finished, failed or been stopped. */
  async function ownerEnded(tx: AgentTransaction, plan: { id: string; chatId: string }) {
    const row = z.object({ owners: z.number().int(), live: z.number().int() }).parse(
      (
        await tx.client.query(
          `SELECT count(*)::integer AS owners,
          count(*) FILTER (WHERE t.status IN ('queued','processing','waiting','reconciling'))::integer AS live
        FROM ${relation(tx, 'tf_conversation_turns')} t
        WHERE t.conversation_id=$1 AND (t.plan_id=$2 OR t.id=(SELECT source_turn_id FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$2)
          OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} a WHERE a.plan_id=$2 AND a.turn_id=t.id))`,
          [plan.chatId, plan.id],
        )
      ).rows[0],
    );
    return row.owners > 0 && row.live === 0;
  }

  /** Builds a worker's brief from its task and the results of the work it depends on. */
  async function brief(tx: AgentTransaction, planId: string, taskKey: string) {
    const rows = await loadTasks(tx, planId);
    const task = rows.find(row => row.key === taskKey);
    if (!task) throw new AccessDenied();
    const prerequisites = z
      .array(
        z.object({
          title: z.string(),
          result: z.string(),
          sources: z.array(sourceDependencySchema),
          agentTaskId: uuidSchema.nullable(),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT t.title, a.result, a.sources, a.agent_task_id AS "agentTaskId" FROM ${relation(tx, 'tf_agent_plan_dependencies')} d
      JOIN ${relation(tx, 'tf_agent_plan_tasks')} t ON t.plan_id=d.plan_id AND t.key=d.depends_on_key
      JOIN ${relation(tx, 'tf_agent_plan_attempts')} a ON a.plan_id=t.plan_id AND a.task_key=t.key AND a.status='completed'
      WHERE d.plan_id=$1 AND d.task_key=$2 AND a.result IS NOT NULL ORDER BY t.position, t.key, a.generation DESC`,
            [planId, taskKey],
          )
        ).rows,
      );
    const inputs = prerequisites.map(row => ({ title: row.title, result: row.result }));
    // Copied results keep their restrictions, as plans.results reports them: a saved agent's result also depends on its private task.
    const sources = [
      ...new Map(
        prerequisites
          .flatMap(row =>
            row.agentTaskId
              ? [...row.sources, { kind: 'private-task' as const, taskId: row.agentTaskId }]
              : row.sources,
          )
          .map(source => [JSON.stringify(source), source]),
      ).values(),
    ];
    return { task, inputs, sources };
  }
  function savedText(
    task: { title: string; brief: string; criteria: readonly string[] },
    inputs: readonly { title: string; result: string }[],
  ) {
    return [
      `Plan task: ${task.title}`,
      task.brief,
      task.criteria.length ? `Done when:\n${task.criteria.map(item => `- ${item}`).join('\n')}` : '',
      ...inputs.map(input => `Result of "${input.title}":\n${input.result}`),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 30000);
  }

  async function coordinatorContext(tx: AgentTransaction, user: string, origin: CoordinatorOrigin, planId: string) {
    await tx.client.query(`SELECT id FROM ${relation(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
      origin.conversationId,
    ]);
    const actor = await turnRequester(tx, origin.conversationId, origin.turnId);
    if (
      actor.userId !== user ||
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')}
      WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND attempt_epoch=$4 AND status='processing'
        AND lease_until>clock_timestamp() AND NOT planning_mode
        AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} n WHERE n.conversation_id=$2
          AND n.accepted_sequence>(SELECT accepted_sequence FROM ${relation(tx, 'tf_conversation_turns')} WHERE id=$1))`,
          [origin.turnId, origin.conversationId, origin.generation, origin.epoch],
        )
      ).rowCount
    )
      throw new AccessDenied();
    const plan = await loadPlan(tx, planId, true);
    if (
      !plan ||
      plan.chatId !== origin.conversationId ||
      plan.starterUserId !== actor.userId ||
      plan.starterMembershipId !== actor.membershipId ||
      !(await starter(tx, plan))
    )
      throw new AccessDenied();
    return { actor, plan };
  }
  async function coordinatorChange(
    tx: AgentTransaction,
    workspaceId: string,
    plan: Plan,
    before: readonly PlanNode[],
    after: PlanNode[],
  ) {
    for (const change of advancePlan(after))
      Object.assign(
        after.find(node => node.key === change.key)!,
        { state: change.to, reason: change.reason },
      );
    const version = plan.version + 1;
    const changes = await persist(tx, plan.id, version, new Map(before.map(node => [node.key, node])), after);
    const lifecycle =
      summarizePlan(after, plan.planning ?? undefined).outcome === 'completed' ? 'completed' : plan.lifecycle;
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_agent_plans')} SET version=$2,lifecycle=$3,updated_at=clock_timestamp() WHERE id=$1`,
      [plan.id, version, lifecycle],
    );
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_plan_events')} (plan_id,version,actor,kind,changes) VALUES ($1,$2,'coordinator','advanced',$3)`,
      [plan.id, version, JSON.stringify(changes)],
    );
    await notifyPlanChange(tx, workspaceId, plan);
    return version;
  }
  const coordinatorReceiptSchema = z.object({
    planId: uuidSchema,
    attemptId: uuidSchema,
    task: z.string(),
    version: z.number().int(),
  });
  async function coordinatorCommand(tx: AgentTransaction, planId: string, requestId: string, command: unknown) {
    const digest = createHash('sha256').update(canonicalJson(command)).digest('hex');
    const prior = z
      .object({ input_digest: z.string(), receipt: coordinatorReceiptSchema })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT input_digest,receipt FROM ${relation(tx, 'tf_agent_plan_commands')} WHERE plan_id=$1 AND request_id=$2`,
            [planId, requestId],
          )
        ).rows[0],
      );
    if (prior && prior.input_digest !== digest) throw new AgentPlanError('idempotency-conflict');
    return {
      prior: prior?.receipt,
      save: async (receipt: z.infer<typeof coordinatorReceiptSchema>) => {
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_commands')} (plan_id,request_id,input_digest,receipt) VALUES ($1,$2,$3,$4)`,
          [planId, requestId, digest, receipt],
        );
        return receipt;
      },
    };
  }
  return {
    async claimCoordinator(workspaceId: string, user: string, source: unknown, input: unknown) {
      const origin = coordinatorOriginSchema.parse(source),
        command = planClaimSchema.parse(input);
      return system(workspaceId, async tx => {
        const { plan, actor } = await coordinatorContext(tx, user, origin, command.planId);
        const recorded = await coordinatorCommand(tx, plan.id, origin.callId, { kind: 'claim', ...command });
        if (recorded.prior) return recorded.prior;
        if (plan.lifecycle !== 'active') throw new AgentPlanError('plan-closed');
        if (plan.version !== command.expectedVersion) throw new AgentPlanError('version-conflict');
        if (!plan.planning) throw new PlanGraphError('planning-required');
        const before = applyPlanningPrerequisites((await loadTasks(tx, plan.id)).map(toNode), plan.planning);
        const nodes = before.map(node => ({ ...node }));
        const task = nodes.find(node => node.key === command.task);
        if (
          !task ||
          task.prerequisiteBlock ||
          !((task.state === 'ready' && task.assignee?.kind === 'coordinator') || task.state === 'verifying')
        )
          throw new PlanGraphError('invalid-transition', command.task);
        for (const check of plan.planning.prerequisites)
          if (check.tasks.includes(task.key) && !check.optional)
            await requirePlanEvidence(tx, actor, plan, check.evidence);
        const attempts = await loadAttempts(tx, plan.id, false);
        if (
          attempts.some(attempt => attempt.open && attempt.coordinator) ||
          attempts.filter(attempt => attempt.taskKey === task.key && attempt.status === 'failed').length >=
            planTaskAttempts
        )
          throw new PlanGraphError('invalid-transition', task.key);
        const used = await committed(tx, attempts);
        const allowance = {
          toolCalls: Math.max(0, plan.budget.toolCalls - used.toolCalls),
          activeMilliseconds: Math.max(0, plan.budget.activeMilliseconds - used.activeMilliseconds),
          credits: Math.max(0, Number((BigInt(plan.budget.credits) * creditUnit - used.credits) / creditUnit)),
        };
        if (!allowance.toolCalls || allowance.activeMilliseconds < 1000 || !allowance.credits)
          throw new PlanGraphError('planning-budget');
        const sequence = z
          .number()
          .int()
          .parse(
            (
              await tx.client.query(
                `SELECT sequence FROM ${relation(tx, 'tf_conversation_tool_calls')} WHERE id=$1 AND turn_id=$2 AND tool='plans.claim'`,
                [origin.callId, origin.turnId],
              )
            ).rows[0]?.sequence,
          );
        const attemptId = randomUUID();
        const generation =
          Math.max(-1, ...attempts.filter(attempt => attempt.taskKey === task.key).map(attempt => attempt.generation)) +
          1;
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_attempts')}
          (id,plan_id,task_key,generation,coordinator,turn_id,turn_generation,turn_epoch,claim_sequence,allowance)
          VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9)`,
          [
            attemptId,
            plan.id,
            task.key,
            generation,
            origin.turnId,
            origin.generation,
            origin.epoch,
            sequence,
            allowance,
          ],
        );
        task.state = 'running';
        task.reason = null;
        const version = await coordinatorChange(tx, workspaceId, plan, before, nodes);
        return recorded.save({ planId: plan.id, attemptId, task: task.key, version });
      });
    },
    async reportCoordinator(workspaceId: string, user: string, source: unknown, input: unknown) {
      const origin = coordinatorOriginSchema.parse(source),
        command = planSubmitReportSchema.parse(input);
      return system(workspaceId, async tx => {
        const { plan, actor } = await coordinatorContext(tx, user, origin, command.planId);
        const recorded = await coordinatorCommand(tx, plan.id, origin.callId, { kind: 'report', ...command });
        if (recorded.prior) return recorded.prior;
        if (plan.lifecycle !== 'active') throw new AgentPlanError('plan-closed');
        if (!plan.planning) throw new PlanGraphError('planning-required');
        const attempt = z
          .object({ task: z.string(), sequence: z.number().int() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT task_key AS task,claim_sequence AS sequence FROM ${relation(tx, 'tf_agent_plan_attempts')}
          WHERE id=$1 AND plan_id=$2 AND coordinator AND settled_at IS NULL AND turn_id=$3 AND turn_generation=$4 AND turn_epoch=$5`,
                [command.attemptId, plan.id, origin.turnId, origin.generation, origin.epoch],
              )
            ).rows[0],
          );
        if (!attempt) throw new AccessDenied();
        const before = applyPlanningPrerequisites((await loadTasks(tx, plan.id)).map(toNode), plan.planning);
        const nodes = before.map(node => ({ ...node })),
          task = nodes.find(node => node.key === attempt.task);
        if (!task || task.state !== 'running') throw new PlanGraphError('invalid-transition', attempt.task);
        validatePlanReport(task, plan.planning, command.report, nodes);
        const sources: SourceDependency[] = [];
        for (const check of [...command.report.checks, ...command.report.requirements])
          sources.push(
            ...(await requirePlanEvidence(tx, actor, plan, check.evidence, check.outcome === 'passed', {
              turnId: origin.turnId,
              afterSequence: attempt.sequence,
            })),
          );
        if (command.report.outcome === 'passed')
          for (const check of plan.planning.prerequisites) {
            if (task.key === plan.planning.verificationTask || check.tasks.includes(task.key))
              await requirePlanEvidence(tx, actor, plan, check.evidence);
          }
        const passed = command.report.outcome === 'passed';
        await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET report=$2 WHERE id=$1`, [
          command.attemptId,
          command.report,
        ]);
        await settle(tx, command.attemptId, passed ? 'completed' : 'failed', {
          result: command.report.summary,
          sources,
        });
        task.state = passed ? 'completed' : 'failed';
        task.reason = passed ? null : command.report.summary.slice(0, planLimits.reason);
        const version = await coordinatorChange(tx, workspaceId, plan, before, nodes);
        return recorded.save({ planId: plan.id, attemptId: command.attemptId, task: task.key, version });
      });
    },
    /**
     * Active plans in a workspace, for recovery after a lost wake. `quiet` plans have no open attempt, so only a change
     * to the plan, which bumps `version` and wakes it directly, or a change outside it can let them progress.
     * `liveOwners` counts a planning plan's unfinished owner turns; when it drops to zero the next step pauses the plan.
     */
    async due(workspaceId: string, after?: string) {
      return runtime.transaction(uuidSchema.parse(workspaceId), planCompatibility, async tx =>
        z
          .array(
            z.object({
              id: uuidSchema,
              version: z.number().int().nonnegative(),
              quiet: z.boolean(),
              liveOwners: z.number().int().nonnegative(),
            }),
          )
          .parse(
            (
              await tx.client.query(
                `SELECT p.id,p.version,NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} a WHERE a.plan_id=p.id AND a.settled_at IS NULL
                  AND COALESCE(a.source_check_after <= clock_timestamp(), true)) AS quiet,
                CASE WHEN p.planning IS NULL THEN 0 ELSE (SELECT count(*)::integer FROM ${relation(tx, 'tf_conversation_turns')} t
                  WHERE t.conversation_id=p.conversation_id AND t.status IN ('queued','processing','waiting','reconciling')
                    AND (t.plan_id=p.id OR t.id=p.source_turn_id
                      OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} a WHERE a.plan_id=p.id AND a.turn_id=t.id))) END AS "liveOwners"
                FROM ${relation(tx, 'tf_agent_plans')} p WHERE p.lifecycle='active' AND ($1::uuid IS NULL OR p.id>$1) ORDER BY p.id LIMIT 100`,
                [after ?? null],
              )
            ).rows,
          ),
      );
    },
    advance,
    /**
     * Runs one plan step: read saved tasks as the starter, advance the plan, then start the saved tasks it claimed.
     * Start requests reuse the attempt ID, so repeating a step after a crash never starts a second task.
     */
    async step(
      workspaceId: string,
      planId: string,
      wakeTask?: (workspaceId: string, taskId: string) => Promise<unknown>,
    ): Promise<PlanProgress> {
      const watched = await runtime.transaction(uuidSchema.parse(workspaceId), planCompatibility, async tx => ({
        plan: await loadPlan(tx, planId, false),
        // A task whose sources were unavailable is not reread before its next check time.
        attempts: (await loadAttempts(tx, uuidSchema.parse(planId), true)).filter(
          attempt => attempt.agentTaskId && attempt.checkAfterMs === null,
        ),
      }));
      if (!watched.plan) return { kind: 'terminal', specialists: [] };
      const observations: SavedTaskObservation[] = [];
      // The reads share one remote-check budget, so once a source is unavailable the rest are not checked this step.
      await withRemoteSourceCheckBudget(async () => {
        for (const attempt of watched.attempts) {
          if (!tasks) break;
          try {
            const read = await deferRemoteSourceChecks(() =>
              tasks.readResult(workspaceId, watched.plan!.starterUserId, attempt.agentTaskId!),
            );
            observations.push({
              attemptId: attempt.id,
              status: read.status,
              ...(read.result === undefined ? {} : { result: read.result }),
            });
          } catch (error) {
            // A source that can't be checked right now revokes nothing; the attempt waits to be read again.
            if (error instanceof SourceAuthorizationUnavailable)
              observations.push({ attemptId: attempt.id, unavailable: true });
            else if (error instanceof AccessDenied)
              observations.push({ attemptId: attempt.id, failure: 'access-revoked' });
            else throw error;
          }
        }
      });
      const advanced = await advance(workspaceId, planId, observations);
      for (const attemptId of advanced.starts) {
        if (!tasks) break;
        const work = await runtime.transaction(uuidSchema.parse(workspaceId), planCompatibility, async tx => {
          const attempt = z
            .object({ taskKey: z.string(), agentId: uuidSchema, activationId: uuidSchema, allowance: allowanceSchema })
            .parse(
              (
                await tx.client.query(
                  `SELECT task_key AS "taskKey", agent_id AS "agentId", activation_id AS "activationId", allowance FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE id=$1`,
                  [attemptId],
                )
              ).rows[0],
            );
          const { task, inputs, sources } = await brief(tx, planId, attempt.taskKey);
          return { ...attempt, text: savedText(task, inputs), sources };
        });
        let taskId: string | null = null;
        let failure: string | null = null;
        try {
          taskId = (
            await tasks.startForWorkflow(
              workspaceId,
              watched.plan.starterUserId,
              {
                requestId: attemptId,
                agentId: work.agentId,
                activationId: work.activationId,
                text: work.text,
                sources: [],
                limits: {
                  toolCalls: work.allowance.toolCalls,
                  activeMilliseconds: Math.max(work.allowance.activeMilliseconds, 1000),
                  credits: work.allowance.credits,
                },
              },
              work.sources,
              async tx => {
                // Conflicts with stop's update of this attempt, so a task is never created after stop settles it.
                const open = await tx.client.query(
                  `SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE id=$1 AND settled_at IS NULL FOR SHARE`,
                  [attemptId],
                );
                if (!open.rowCount) throw new AttemptClosed();
              },
              { kind: 'plan-attempt', attemptId },
            )
          ).id;
        } catch (error) {
          if (error instanceof AttemptClosed) failure = 'stopped';
          else if (error instanceof AccessDenied) failure = 'access-revoked';
          else if (error instanceof AgentTaskError) failure = error.code;
          else throw error;
        }
        const wake = await system(workspaceId, async tx => {
          const plan = await loadPlan(tx, planId, true);
          if (!plan) return false;
          if (taskId) {
            const attempt = z
              .object({ linked: z.boolean(), settled: z.boolean() })
              .parse(
                (
                  await tx.client.query(
                    `SELECT agent_task_id IS NOT NULL AS linked, settled_at IS NOT NULL AS settled FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE id=$1 FOR UPDATE`,
                    [attemptId],
                  )
                ).rows[0],
              );
            if (!attempt.linked)
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET agent_task_id=$2 WHERE id=$1`,
                [attemptId, taskId],
              );
            if (!attempt.settled && plan.lifecycle !== 'stopped') return true;
            if (attempt.linked) return false;
            // Stop settled this attempt before it was linked, so stop could not find and pause the task.
            const paused = await tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status='paused',pause_reason='plan' WHERE id=$1 AND status NOT IN ('completed','failed','paused')`,
              [taskId],
            );
            taskTransition(tx, 'paused', paused.rowCount);
            return false;
          }
          if (!(await settle(tx, attemptId, 'failed', { failure: failure ?? 'start-failed' }))) return false;
          const rows = await loadTasks(tx, planId);
          const before = new Map(rows.map(row => [row.key, toNode(row)]));
          const after = rows.map(row => ({ ...toNode(row) }));
          const node = after.find(item => item.key === work.taskKey);
          if (node) {
            node.state = 'failed';
            node.reason = failure === 'access-revoked' ? reasons.agentAccess : reasons.savedFailed;
          }
          const version = plan.version + 1;
          const changes = await persist(tx, planId, version, before, after);
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_plans')} SET version=$2, updated_at=clock_timestamp() WHERE id=$1`,
            [planId, version],
          );
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_plan_events')} (plan_id,version,actor,kind,changes) VALUES ($1,$2,'runtime','advanced',$3)`,
            [planId, version, JSON.stringify(changes)],
          );
          await notifyPlanChange(tx, workspaceId, plan);
          return false;
        });
        if (taskId && wake) await wakeTask?.(workspaceId, taskId);
      }
      return {
        ...advanced.progress,
        kind: advanced.starts.length && advanced.progress.kind === 'terminal' ? 'waiting' : advanced.progress.kind,
      };
    },
    /** Returns the assignment of a live specialist attempt, or null when it was settled, stopped or lost its lease. */
    async claimSpecialist(workspaceId: string, attemptId: string): Promise<SpecialistAssignment | null> {
      return system(workspaceId, async tx => {
        const row = z
          .object({
            planId: uuidSchema,
            taskKey: z.string(),
            generation: z.number().int(),
            specialist: z.string(),
            allowance: allowanceSchema,
          })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT plan_id AS "planId", task_key AS "taskKey", generation, specialist_key AS specialist, allowance FROM ${relation(tx, 'tf_agent_plan_attempts')}
           WHERE id=$1 AND status='running' AND settled_at IS NULL AND specialist_key IS NOT NULL AND lease_until > clock_timestamp()`,
                [uuidSchema.parse(attemptId)],
              )
            ).rows[0],
          );
        if (!row) return null;
        const plan = await loadPlan(tx, row.planId, false);
        if (!plan || plan.lifecycle !== 'active') return null;
        const definition = specialistInputSchema.parse(
          (
            await tx.client.query(
              `SELECT definition FROM ${relation(tx, 'tf_agent_plan_specialists')} WHERE plan_id=$1 AND key=$2`,
              [row.planId, row.specialist],
            )
          ).rows[0]?.definition,
        );
        const { task, inputs, sources: inputSources } = await brief(tx, row.planId, row.taskKey);
        return {
          attemptId,
          planId: row.planId,
          chatId: plan.chatId,
          generation: row.generation,
          starterUserId: plan.starterUserId,
          starterMembershipId: plan.starterMembershipId,
          name: definition.name,
          role: definition.role,
          instructions: definition.instructions,
          ...(definition.modelFamilyId ? { modelFamilyId: definition.modelFamilyId } : {}),
          tools: definition.tools,
          title: task.title,
          brief: task.brief,
          criteria: task.criteria,
          inputs,
          inputSources,
          allowance: row.allowance,
          planning: plan.planning !== null,
        };
      });
    },
    /**
     * Admits one specialist model step: extends the lease, checks the attempt's credit allowance, then runs `reserve`
     * in the same transaction. Returns false when the attempt lost its lease, its plan stopped running, its starter lost
     * access, or the step would exceed the allowance.
     */
    async admitSpecialistStep(
      workspaceId: string,
      attemptId: string,
      reservationPicoUsd: bigint,
      reserve: (tx: AgentTransaction) => Promise<boolean>,
    ) {
      return system(workspaceId, async tx => {
        const row = z
          .object({ planId: uuidSchema, allowance: allowanceSchema })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT plan_id AS "planId", allowance FROM ${relation(tx, 'tf_agent_plan_attempts')}
          WHERE id=$1 AND status='running' AND settled_at IS NULL AND lease_until > clock_timestamp() FOR UPDATE`,
                [uuidSchema.parse(attemptId)],
              )
            ).rows[0],
          );
        if (!row) return false;
        const plan = await loadPlan(tx, row.planId, false);
        if (!plan || plan.lifecycle !== 'active' || !(await starter(tx, plan))) return false;
        if (
          (await flowSpend(tx, attemptId)) + creditUnitsForProviderCost(reservationPicoUsd) >
          BigInt(row.allowance.credits) * creditUnit
        )
          return false;
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET lease_until=clock_timestamp()+make_interval(secs => $2) WHERE id=$1`,
          [attemptId, specialistLeaseMilliseconds / 1000],
        );
        return reserve(tx);
      });
    },
    /** The transaction compatibility that plan runtime work needs. */
    compatibility: planCompatibility,
    async guardSpecialist(tx: AgentTransaction, attemptId: string) {
      await lockAuthorization(tx, 'read');
      await tx.client.query(
        `SELECT c.id FROM ${relation(tx, 'tf_conversations')} c JOIN ${relation(tx, 'tf_agent_plans')} p ON p.conversation_id=c.id JOIN ${relation(tx, 'tf_agent_plan_attempts')} a ON a.plan_id=p.id WHERE a.id=$1 FOR UPDATE OF c`,
        [attemptId],
      );
      const row = z
        .object({ planId: uuidSchema })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT plan_id AS "planId" FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE id=$1 AND status='running' AND specialist_key IS NOT NULL AND settled_at IS NULL AND lease_until>clock_timestamp()`,
              [uuidSchema.parse(attemptId)],
            )
          ).rows[0],
        );
      if (!row) throw new AccessDenied();
      const plan = await loadPlan(tx, row.planId, true);
      if (!plan || plan.lifecycle !== 'active') throw new AccessDenied();
      const actor = await starter(tx, plan);
      if (!actor) throw new AccessDenied();
      const live = (
        await tx.client.query(
          `SELECT id FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE id=$1 AND status='running' AND settled_at IS NULL AND lease_until>clock_timestamp() FOR UPDATE`,
          [attemptId],
        )
      ).rowCount;
      if (!live) throw new AccessDenied();
      return actor;
    },
    /** Extends a live specialist attempt's lease while a long tool call runs between model steps. Run after `guardSpecialist`. */
    async renewSpecialistLease(tx: AgentTransaction, attemptId: string) {
      const renewed = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET lease_until=clock_timestamp()+make_interval(secs => $2)
          WHERE id=$1 AND status='running' AND settled_at IS NULL AND lease_until>clock_timestamp()`,
        [uuidSchema.parse(attemptId), specialistLeaseMilliseconds / 1000],
      );
      if (!renewed.rowCount) throw new AccessDenied();
    },
    /** Records a specialist's result once. A stale or settled attempt changes nothing and returns false. */
    async settleSpecialist(
      workspaceId: string,
      attemptId: string,
      outcome: SpecialistOutcome,
      usage: { toolCalls: number; activeMilliseconds: number },
    ) {
      return system(workspaceId, async tx => {
        const row = z
          .object({ planId: uuidSchema, taskKey: z.string(), generation: z.number().int() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT plan_id AS "planId", task_key AS "taskKey", generation FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE id=$1 AND status='running' AND settled_at IS NULL AND specialist_key IS NOT NULL AND lease_until>clock_timestamp()`,
                [uuidSchema.parse(attemptId)],
              )
            ).rows[0],
          );
        if (!row) return false;
        const plan = await loadPlan(tx, row.planId, true);
        if (!plan || plan.lifecycle !== 'active') return false;
        const retainedUsage = z
          .object({ toolCalls: z.number().int(), activeMilliseconds: z.coerce.number().int() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT tool_calls AS "toolCalls",active_milliseconds AS "activeMilliseconds" FROM ${relation(tx, 'tf_agent_plan_attempts')} WHERE id=$1 AND status='running' AND settled_at IS NULL AND lease_until>clock_timestamp() FOR UPDATE`,
                [attemptId],
              )
            ).rows[0],
          );
        if (!retainedUsage) return false;
        usage = {
          toolCalls: Math.max(usage.toolCalls, retainedUsage.toolCalls),
          activeMilliseconds: Math.max(usage.activeMilliseconds, retainedUsage.activeMilliseconds),
        };
        if (outcome.kind === 'completed') {
          const actor = await starter(tx, plan);
          if (!actor) return false;
          try {
            await requireDraftSources(tx, actor, z.array(sourceDependencySchema).parse(outcome.sources));
          } catch (error) {
            if (!(error instanceof AccessDenied)) throw error;
            outcome = { kind: 'failed', code: 'access-revoked' };
          }
        }
        const sources = z.array(sourceDependencySchema).parse(outcome.kind === 'completed' ? outcome.sources : []);
        const report = outcome.kind === 'completed' ? outcome.report : undefined;
        const incomplete = !!report && report.outcome !== 'passed';
        const nonRetryable = outcome.kind === 'failed' && nonRetryableSpecialistFailures.has(outcome.code);
        if (
          !(await settle(
            tx,
            attemptId,
            incomplete ? 'failed' : outcome.kind,
            outcome.kind === 'completed'
              ? {
                  liveSpecialist: true,
                  result: outcome.result,
                  sources,
                  usage,
                  ...(incomplete ? { failure: `worker-${report.outcome}` } : {}),
                }
              : { liveSpecialist: true, failure: outcome.code, usage },
          ))
        )
          return false;
        if (report)
          await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET report=$2 WHERE id=$1`, [
            attemptId,
            {
              outcome: report.outcome,
              summary: report.summary,
              checks: report.checks.map(check => ({
                criterion: check.criterion,
                outcome: check.outcome,
                evidence: [],
              })),
              requirements: [],
            },
          ]);
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plans')} SET tool_calls=tool_calls+$2, active_milliseconds=active_milliseconds+$3 WHERE id=$1`,
          [row.planId, usage.toolCalls, usage.activeMilliseconds],
        );
        const rows = await loadTasks(tx, row.planId);
        const before = new Map(rows.map(item => [item.key, toNode(item)]));
        const after = rows.map(item => ({ ...toNode(item) }));
        const node = after.find(item => item.key === row.taskKey);
        if (node && node.state === 'running') {
          const exhausted = (await failures(tx, row.planId, row.taskKey)) >= planTaskAttempts;
          node.state =
            incomplete || nonRetryable
              ? 'failed'
              : outcome.kind === 'completed'
                ? plan.planning
                  ? 'verifying'
                  : 'completed'
                : exhausted
                  ? 'failed'
                  : 'pending';
          node.reason = incomplete
            ? report.summary.slice(0, planLimits.reason)
            : nonRetryable && outcome.kind === 'failed'
              ? `Worker stopped: ${outcome.code}. Resolve this before retrying.`
              : node.state === 'verifying'
                ? 'The main agent must check this report against the task criteria.'
                : outcome.kind === 'completed' || !exhausted
                  ? null
                  : reasons.attemptsExhausted;
        }
        const version = plan.version + 1;
        const lifecycleChanges: unknown[] = [];
        if (nonRetryable && plan.lifecycle === 'active') {
          await pausePlanWork(tx, plan.id, after);
          lifecycleChanges.push({
            op: 'lifecycle',
            to: 'paused',
            reason:
              outcome.kind === 'failed' && ['credits-exhausted', 'step-not-admitted'].includes(outcome.code)
                ? 'budget'
                : 'progress',
          });
        }
        const changes = [...(await persist(tx, row.planId, version, before, after)), ...lifecycleChanges];
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plans')} SET version=$2,lifecycle=$3,updated_at=clock_timestamp() WHERE id=$1`,
          [row.planId, version, nonRetryable && plan.lifecycle === 'active' ? 'paused' : plan.lifecycle],
        );
        if (nonRetryable) await wakePlanWait(tx, plan);
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_events')} (plan_id,version,actor,kind,changes) VALUES ($1,$2,'runtime','advanced',$3)`,
          [row.planId, version, JSON.stringify(changes)],
        );
        await notifyPlanChange(tx, workspaceId, plan);
        return true;
      });
    },
  };
}

export type PlanRuntime = ReturnType<typeof createPlanRuntime>;
export type { PlanNode };
