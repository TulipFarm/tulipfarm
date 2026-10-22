import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  lockAuthorization,
  requireTaskInvocation,
  resolveHuman,
  uuidSchema,
  AccessDenied,
  type HumanActor,
} from '@tulipfarm/access';
import { sourceDependencySchema } from '@tulipfarm/access/source-dependencies';
import { authorizeChat, type ChatAccessRule } from '@tulipfarm/conversations/chat-access';
import { notifyConversationChange } from '@tulipfarm/conversations/event-publisher';
import { createConversations } from '@tulipfarm/conversations';
import { boundRuntime } from './task-approval-gate.ts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { taskTransition } from './task-telemetry.ts';
import { requirePlanEvidence } from './plan-evidence.ts';
import {
  AgentPlanError,
  applyPlanMutations,
  buildInitialPlan,
  createPlanSchema,
  planBudgetSchema,
  planControlSchema,
  planKeySchema,
  planPauseSchema,
  planLimits,
  planListItemSchema,
  planReceiptSchema,
  planTaskStateSchema,
  planViewSchema,
  PlanGraphError,
  specialistInputSchema,
  summarizePlan,
  updatePlanSchema,
  advancePlan,
  applyPlanningPrerequisites,
  planSpecificationSchema,
  planReportSchema,
  planLifecycleSchema,
  validatePlanning,
  type PlanActor,
  type PlanNode,
  type PlanView,
} from './plan-contracts.ts';

export const planCompatibility = Object.freeze({ minimum: 1, maximum: commonCompatibility.maximum });

const planRowSchema = z.object({
  id: uuidSchema,
  chatId: uuidSchema,
  starterUserId: z.string(),
  starterMembershipId: uuidSchema,
  title: z.string(),
  brief: z.string(),
  lifecycle: planLifecycleSchema,
  execution: z.enum(['plan-only', 'execute']),
  planning: planSpecificationSchema.nullable(),
  version: z.number().int().nonnegative(),
  budget: planBudgetSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
const planColumns = `id, conversation_id AS "chatId", starter_user_id AS "starterUserId", starter_membership_id AS "starterMembershipId", title, brief, lifecycle, execution, planning, version, budget, created_at::text AS "createdAt", updated_at::text AS "updatedAt"`;
const stoppedReason = 'Stopped by the person who started the plan.';
const taskRowSchema = z.object({
  id: uuidSchema,
  key: planKeySchema,
  parent: planKeySchema.nullable(),
  position: z.number().int().nonnegative(),
  kind: z.enum(['group', 'work']),
  order: z.enum(['parallel', 'serial']),
  title: z.string(),
  brief: z.string(),
  criteria: z.array(z.string()),
  agentId: uuidSchema.nullable(),
  agentName: z.string().nullable(),
  coordinator: z.boolean(),
  specialist: planKeySchema.nullable(),
  state: planTaskStateSchema,
  reason: z.string().nullable(),
  dependsOn: z.array(planKeySchema),
});
const specialistRowSchema = z.object({ key: planKeySchema, definition: specialistInputSchema });
type PlanRow = z.infer<typeof planRowSchema>;
type TaskRow = z.infer<typeof taskRowSchema>;
type Specialist = z.infer<typeof specialistInputSchema>;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const toNode = (task: TaskRow): PlanNode => ({
  key: task.key,
  parent: task.parent,
  position: task.position,
  kind: task.kind,
  order: task.order,
  dependsOn: task.dependsOn,
  state: task.state,
  assignee: task.coordinator
    ? { kind: 'coordinator' }
    : task.agentId
      ? { kind: 'agent', agentId: task.agentId }
      : task.specialist
        ? { kind: 'specialist', specialist: task.specialist }
        : null,
  title: task.title,
  brief: task.brief,
  criteria: task.criteria,
  reason: task.reason,
});

export async function loadTasks(tx: AgentTransaction, planId: string) {
  return z.array(taskRowSchema).parse(
    (
      await tx.client.query(
        `SELECT t.id, t.key, t.parent_key AS parent, t.position, t.kind, t.order_mode AS "order", t.title, t.brief, t.criteria,
      t.agent_id AS "agentId", t.coordinator, t.specialist_key AS specialist, t.state, t.reason,
      COALESCE((SELECT array_agg(d.depends_on_key ORDER BY d.depends_on_key) FROM ${relation(tx, 'tf_agent_plan_dependencies')} d WHERE d.plan_id=t.plan_id AND d.task_key=t.key), '{}') AS "dependsOn",
      (SELECT f.definition->>'name' FROM ${relation(tx, 'tf_agent_activations')} a JOIN ${relation(tx, 'tf_agent_definitions')} f ON f.agent_id=a.agent_id AND f.revision=a.definition_revision
        WHERE a.agent_id=t.agent_id AND a.revoked_at IS NULL ORDER BY a.activated_at DESC NULLS LAST, a.id DESC LIMIT 1) AS "agentName"
    FROM ${relation(tx, 'tf_agent_plan_tasks')} t WHERE t.plan_id=$1 ORDER BY t.parent_key NULLS FIRST, t.position, t.key`,
        [planId],
      )
    ).rows,
  );
}
/** Tells the plan's chat that the plan changed. PostgreSQL delivers it only if the transaction commits. */
export async function notifyPlanChange(
  tx: AgentTransaction,
  workspaceId: string,
  plan: { id: string; chatId: string },
) {
  await notifyConversationChange(tx, { workspaceId, conversationId: plan.chatId, planId: plan.id });
}
export async function wakePlanWait(tx: AgentTransaction, plan: { id: string; chatId: string }) {
  await tx.client.query(
    `WITH resumed AS (
    UPDATE ${relation(tx, 'tf_conversation_turns')} t SET status='queued',generation=generation+1,error_code=NULL,retry_at=NULL
    WHERE t.conversation_id=$1 AND t.status='waiting' AND t.error_code='plan-worker-waiting'
      AND (t.plan_id=$2 OR t.id=(SELECT source_turn_id FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$2)
        OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_plan_attempts')} a WHERE a.plan_id=$2 AND a.turn_id=t.id))
    RETURNING id,conversation_id,generation)
    INSERT INTO ${relation(tx, 'tf_conversation_outbox')} (turn_id,conversation_id,generation)
    SELECT id,conversation_id,generation FROM resumed`,
    [plan.chatId, plan.id],
  );
}
export async function pausePlanWork(tx: AgentTransaction, planId: string, nodes: PlanNode[]) {
  const cancelled = z.array(z.object({ key: planKeySchema, coordinator: z.boolean() })).parse(
    (
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET status='cancelled',lease_until=NULL,settled_at=clock_timestamp()
    WHERE plan_id=$1 AND settled_at IS NULL AND (specialist_key IS NOT NULL OR coordinator) RETURNING task_key AS key,coordinator`,
        [planId],
      )
    ).rows,
  );
  for (const item of cancelled) {
    const node = nodes.find(node => node.key === item.key);
    if (node?.state !== 'running') continue;
    node.state = item.coordinator ? 'verifying' : 'pending';
    node.reason = item.coordinator
      ? 'Check the existing actions before resuming; the previous claim was stopped.'
      : null;
  }
}
/** Writes the difference between two outlines. Rows are never deleted, so the history of each task remains. */
export async function persist(
  tx: AgentTransaction,
  planId: string,
  version: number,
  before: ReadonlyMap<string, PlanNode>,
  after: readonly PlanNode[],
) {
  const changes: unknown[] = [];
  for (const node of after) {
    const agentId = node.assignee?.kind === 'agent' ? node.assignee.agentId : null;
    const specialist = node.assignee?.kind === 'specialist' ? node.assignee.specialist : null;
    const coordinator = node.assignee?.kind === 'coordinator';
    const prior = before.get(node.key);
    if (!prior) {
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_plan_tasks')} (id,plan_id,key,parent_key,position,kind,order_mode,title,brief,criteria,agent_id,specialist_key,state,reason,created_version,coordinator)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          randomUUID(),
          planId,
          node.key,
          node.parent,
          node.position,
          node.kind,
          node.order,
          node.title,
          node.brief ?? '',
          JSON.stringify(node.criteria ?? []),
          agentId,
          specialist,
          node.kind === 'group' ? 'pending' : node.state,
          node.reason ?? null,
          version,
          coordinator,
        ],
      );
      changes.push({ op: 'add', key: node.key, state: node.state });
    } else if (
      prior.title !== node.title ||
      prior.brief !== node.brief ||
      canonicalJson(prior.criteria) !== canonicalJson(node.criteria) ||
      canonicalJson(prior.assignee) !== canonicalJson(node.assignee) ||
      (node.kind === 'work' && prior.state !== node.state) ||
      (prior.reason ?? null) !== (node.reason ?? null)
    ) {
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_plan_tasks')} SET title=$3,brief=$4,criteria=$5,agent_id=$6,specialist_key=$7,state=$8,reason=$9,coordinator=$10,updated_at=clock_timestamp() WHERE plan_id=$1 AND key=$2`,
        [
          planId,
          node.key,
          node.title,
          node.brief ?? '',
          JSON.stringify(node.criteria ?? []),
          agentId,
          specialist,
          node.kind === 'group' ? 'pending' : node.state,
          node.reason ?? null,
          coordinator,
        ],
      );
      changes.push({
        op: 'change',
        key: node.key,
        ...(prior.state !== node.state && node.kind === 'work' ? { from: prior.state, to: node.state } : {}),
      });
    }
    const old = new Set(prior?.dependsOn ?? []),
      next = new Set(node.dependsOn);
    for (const target of next)
      if (!old.has(target))
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_dependencies')} (plan_id,task_key,depends_on_key) VALUES ($1,$2,$3)`,
          [planId, node.key, target],
        );
    for (const target of old)
      if (!next.has(target))
        await tx.client.query(
          `DELETE FROM ${relation(tx, 'tf_agent_plan_dependencies')} WHERE plan_id=$1 AND task_key=$2 AND depends_on_key=$3`,
          [planId, node.key, target],
        );
  }
  return changes;
}
export function createAgentPlans(runtime: AgentStorage) {
  async function transaction<T>(
    workspaceId: string,
    user: string,
    write: boolean,
    operation: (tx: AgentTransaction & { commonVersion: number }, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), planCompatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      return operation(tx, await resolveHuman(tx, user));
    });
  }
  async function requireChat(tx: AgentTransaction, actor: HumanActor, chatId: string, rule: ChatAccessRule) {
    const chat = z
      .object({ owner: z.boolean(), projectId: uuidSchema.nullable() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT (owner_user_id=$2 AND owner_membership_id=$3) AS owner, project_id AS "projectId"
      FROM ${relation(tx, 'tf_conversations')} WHERE id=$1 AND kind='private' AND deleted_at IS NULL ${rule === 'turn' ? 'FOR UPDATE' : ''}`,
            [uuidSchema.parse(chatId), actor.userId, actor.membershipId],
          )
        ).rows[0],
      );
    if (!chat) throw new AccessDenied();
    await authorizeChat(tx, actor, chat, rule);
  }
  async function loadPlan(tx: AgentTransaction, actor: HumanActor, planId: string, lock: boolean) {
    const plan = planRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT ${planColumns} FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$1`, [
            uuidSchema.parse(planId),
          ])
        ).rows[0],
      );
    if (!plan) throw new AccessDenied();
    await requireChat(tx, actor, plan.chatId, lock ? 'turn' : 'read');
    return lock
      ? planRowSchema.parse(
          (
            await tx.client.query(
              `SELECT ${planColumns} FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$1 FOR UPDATE`,
              [planId],
            )
          ).rows[0],
        )
      : plan;
  }
  function requireStarter(plan: PlanRow, actor: HumanActor) {
    if (plan.starterUserId !== actor.userId || plan.starterMembershipId !== actor.membershipId)
      throw new AgentPlanError('not-starter');
  }
  async function loadSpecialists(tx: AgentTransaction, planId: string) {
    return z
      .array(specialistRowSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT key, definition FROM ${relation(tx, 'tf_agent_plan_specialists')} WHERE plan_id=$1 ORDER BY key`,
            [planId],
          )
        ).rows,
      )
      .map(row => row.definition);
  }
  /** The starter must be allowed to invoke every saved agent a plan names; specialists are checked by schema. */
  async function requireAssignable(tx: AgentTransaction, actor: HumanActor, nodes: readonly PlanNode[]) {
    const agents = new Set(nodes.flatMap(node => (node.assignee?.kind === 'agent' ? [node.assignee.agentId] : [])));
    for (const agentId of agents) await requireTaskInvocation(tx, actor, agentId);
  }
  async function insertSpecialists(
    tx: AgentTransaction,
    planId: string,
    version: number,
    specialists: readonly Specialist[],
  ) {
    for (const specialist of specialists)
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_plan_specialists')} (plan_id,key,definition,created_version) VALUES ($1,$2,$3,$4)`,
        [planId, specialist.key, specialist, version],
      );
  }
  async function event(
    tx: AgentTransaction,
    planId: string,
    version: number,
    actor: PlanActor,
    kind: 'created' | 'updated',
    changes: unknown[],
  ) {
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_plan_events')} (plan_id,version,actor,kind,changes) VALUES ($1,$2,$3,$4,$5)`,
      [
        planId,
        version,
        actor.kind === 'coordinator' ? 'coordinator' : `worker:${actor.task}`,
        kind,
        JSON.stringify(changes),
      ],
    );
  }
  /** The reason of the latest pause, read from the plan's history. */
  async function pauseReason(tx: AgentTransaction, plan: PlanRow) {
    if (plan.lifecycle !== 'paused') return null;
    const reason = (
      await tx.client.query(
        `SELECT change->>'reason' AS reason FROM ${relation(tx, 'tf_agent_plan_events')} e, jsonb_array_elements(e.changes) change
      WHERE e.plan_id=$1 AND change->>'op'='lifecycle' AND change->>'to'='paused' ORDER BY e.version DESC LIMIT 1`,
        [plan.id],
      )
    ).rows[0]?.reason;
    return planPauseSchema.catch('starter').parse(reason);
  }
  /** Saved tasks where the starter answers a waiting plan task, by task key. */
  async function waitingTasks(tx: AgentTransaction, plan: PlanRow, actor: HumanActor) {
    if (plan.starterUserId !== actor.userId || plan.starterMembershipId !== actor.membershipId)
      return new Map<string, string>();
    const rows = z.array(z.object({ key: planKeySchema, taskId: uuidSchema })).parse(
      (
        await tx.client.query(
          `SELECT task_key AS key, agent_task_id AS "taskId" FROM ${relation(tx, 'tf_agent_plan_attempts')}
      WHERE plan_id=$1 AND settled_at IS NULL AND status IN ('waiting-input','waiting-approval') AND agent_task_id IS NOT NULL`,
          [plan.id],
        )
      ).rows,
    );
    return new Map(rows.map(row => [row.key, row.taskId]));
  }
  function view(
    plan: PlanRow,
    tasks: readonly TaskRow[],
    specialists: readonly Specialist[],
    actor: HumanActor,
    pause: z.infer<typeof planPauseSchema> | null = null,
    waiting: ReadonlyMap<string, string> = new Map(),
  ): PlanView {
    const nodes = applyPlanningPrerequisites(tasks.map(toNode), plan.planning ?? undefined);
    const summary = summarizePlan(nodes, plan.planning ?? undefined);
    const names = new Map(specialists.map(item => [item.key, item.name]));
    return planViewSchema.parse({
      id: plan.id,
      chatId: plan.chatId,
      title: plan.title,
      brief: plan.brief,
      lifecycle: plan.lifecycle,
      version: plan.version,
      planning: plan.planning,
      canControl: plan.starterUserId === actor.userId && plan.starterMembershipId === actor.membershipId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      counts: summary.counts,
      outcome: summary.outcome,
      pause,
      budget: plan.budget,
      specialists: specialists.map(({ key, name, role }) => ({ key, name, role })),
      tasks: tasks.map(task => ({
        id: task.id,
        key: task.key,
        parent: task.parent,
        position: task.position,
        kind: task.kind,
        order: task.order,
        title: task.title,
        brief: task.brief,
        criteria: task.criteria,
        dependsOn: task.dependsOn,
        state: task.state,
        reason: task.reason,
        assignee: task.coordinator
          ? { kind: 'coordinator' }
          : task.agentId
            ? { kind: 'agent', agentId: task.agentId, name: task.agentName }
            : task.specialist
              ? { kind: 'specialist', specialist: task.specialist, name: names.get(task.specialist) ?? task.specialist }
              : null,
        summary: summary.groups.get(task.key) ?? null,
        waitingTaskId:
          task.kind === 'work' && (task.state === 'waiting-input' || task.state === 'waiting-approval')
            ? (waiting.get(task.key) ?? null)
            : null,
      })),
    });
  }

  return {
    /** Creates the chat's open plan for this starter from one atomic outline. Replaying the same request returns its receipt. */
    async create(
      workspaceId: string,
      user: string,
      chatId: string,
      requestId: string,
      input: unknown,
      sourceTurnId: string | null = null,
    ) {
      const command = createPlanSchema.parse(input);
      return transaction(workspaceId, user, true, async (tx, actor) => {
        await requireChat(tx, actor, chatId, 'turn');
        const inputDigest = digest({ chatId, command });
        const prior = z
          .object({ input_digest: z.string(), plan_id: uuidSchema })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT input_digest, plan_id FROM ${relation(tx, 'tf_agent_plan_creations')} WHERE membership_id=$1 AND request_id=$2`,
                [actor.membershipId, uuidSchema.parse(requestId)],
              )
            ).rows[0],
          );
        if (prior) {
          const { execution, planning, ...legacy } = command;
          if (
            prior.input_digest !== inputDigest &&
            !(
              execution === 'execute' &&
              planning === undefined &&
              prior.input_digest === digest({ chatId, command: legacy })
            )
          )
            throw new AgentPlanError('idempotency-conflict');
          return planReceiptSchema.parse({
            id: prior.plan_id,
            version: 0,
            added: command.tasks.map(task => task.key),
            yielded: false,
          });
        }
        if (
          (
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_agent_plans')} WHERE conversation_id=$1 AND starter_membership_id=$2 AND lifecycle IN ('draft','active','paused') FOR UPDATE`,
              [chatId, actor.membershipId],
            )
          ).rowCount
        )
          throw new AgentPlanError('plan-open');
        const built = buildInitialPlan(command);
        if (
          sourceTurnId &&
          !(
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} t
          JOIN ${relation(tx, 'tf_conversation_messages')} m ON m.id=t.source_message_id AND m.conversation_id=t.conversation_id
          WHERE t.id=$1 AND t.conversation_id=$2 AND m.membership_id=$3 AND m.author_kind='human'`,
              [uuidSchema.parse(sourceTurnId), chatId, actor.membershipId],
            )
          ).rowCount
        )
          throw new AccessDenied();
        for (const check of command.planning?.prerequisites ?? [])
          await requirePlanEvidence(
            tx,
            actor,
            { chatId, starterMembershipId: actor.membershipId },
            check.evidence,
            check.status === 'verified',
          );
        await requireAssignable(tx, actor, built.nodes);
        const id = randomUUID();
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plans')} (id,conversation_id,starter_user_id,starter_membership_id,source_turn_id,title,brief,budget,execution,planning,lifecycle) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            chatId,
            actor.userId,
            actor.membershipId,
            sourceTurnId,
            command.title,
            command.brief,
            command.budget,
            command.execution,
            command.planning ?? null,
            command.execution === 'plan-only' ? 'draft' : 'active',
          ],
        );
        await insertSpecialists(tx, id, 0, command.specialists);
        const changes = await persist(tx, id, 0, new Map(), built.nodes);
        await event(tx, id, 0, { kind: 'coordinator' }, 'created', changes);
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_creations')} (membership_id,request_id,input_digest,plan_id) VALUES ($1,$2,$3,$4)`,
          [actor.membershipId, requestId, inputDigest, id],
        );
        await notifyPlanChange(tx, workspaceId, { id, chatId });
        return planReceiptSchema.parse({ id, version: 0, added: built.added, yielded: false });
      });
    },
    /** Applies one versioned batch for the starter's coordinator or a worker limited to its own subtree. */
    async update(
      workspaceId: string,
      user: string,
      planId: string,
      requestId: string,
      input: unknown,
      planActor: PlanActor = { kind: 'coordinator' },
    ) {
      const command = updatePlanSchema.parse(input);
      return transaction(workspaceId, user, true, async (tx, actor) => {
        const plan = await loadPlan(tx, actor, planId, true);
        requireStarter(plan, actor);
        const inputDigest = digest({ planActor, command });
        const prior = z
          .object({ input_digest: z.string(), receipt: planReceiptSchema })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT input_digest, receipt FROM ${relation(tx, 'tf_agent_plan_commands')} WHERE plan_id=$1 AND request_id=$2`,
                [plan.id, uuidSchema.parse(requestId)],
              )
            ).rows[0],
          );
        if (prior) {
          if (prior.input_digest !== inputDigest) throw new AgentPlanError('idempotency-conflict');
          return prior.receipt;
        }
        if (plan.lifecycle !== 'draft' && plan.lifecycle !== 'active' && plan.lifecycle !== 'paused')
          throw new AgentPlanError('plan-closed');
        if (plan.version !== command.expectedVersion) throw new AgentPlanError('version-conflict');
        if (planActor.kind === 'worker' && (command.specialists.length > 0 || command.planning))
          throw new PlanGraphError('outside-scope');
        const tasks = await loadTasks(tx, plan.id);
        const existing = await loadSpecialists(tx, plan.id);
        const keys = new Set([...existing.map(item => item.key), ...tasks.map(task => task.key)]);
        for (const specialist of command.specialists) {
          if (keys.has(specialist.key)) throw new PlanGraphError('duplicate-key', specialist.key);
          keys.add(specialist.key);
        }
        if (existing.length + command.specialists.length > planLimits.specialists)
          throw new PlanGraphError('too-many-specialists');
        const before = applyPlanningPrerequisites(tasks.map(toNode), plan.planning ?? undefined);
        const result = applyPlanMutations(before, command.mutations, {
          actor: planActor,
          specialists: new Set([...existing, ...command.specialists].map(item => item.key)),
        });
        const planning = command.planning ?? plan.planning ?? undefined;
        validatePlanning(result.nodes, planning, plan.planning ?? undefined);
        for (const check of planning?.prerequisites ?? [])
          await requirePlanEvidence(tx, actor, plan, check.evidence, check.status === 'verified');
        const nodes = applyPlanningPrerequisites(result.nodes, planning);
        for (const change of advancePlan(nodes)) nodes.find(node => node.key === change.key)!.state = change.to;
        await requireAssignable(
          tx,
          actor,
          nodes.filter(node =>
            command.mutations.some(
              mutation =>
                (mutation.op === 'assign' && mutation.key === node.key) ||
                (mutation.op === 'add' && mutation.task.key === node.key),
            ),
          ),
        );
        const version = plan.version + 1;
        await insertSpecialists(tx, plan.id, version, command.specialists);
        const changes = await persist(tx, plan.id, version, new Map(before.map(node => [node.key, node])), nodes);
        if (command.planning)
          changes.push({
            op: 'planning',
            prerequisites: planning?.prerequisites.map(({ key, status }) => ({ key, status })),
          });
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plans')} SET version=$2, planning=$3, updated_at=clock_timestamp() WHERE id=$1`,
          [plan.id, version, planning ?? null],
        );
        await event(tx, plan.id, version, planActor, 'updated', changes);
        const receipt = planReceiptSchema.parse({ id: plan.id, version, added: result.added, yielded: result.yielded });
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_commands')} (plan_id,request_id,input_digest,receipt) VALUES ($1,$2,$3,$4)`,
          [plan.id, requestId, inputDigest, receipt],
        );
        await notifyPlanChange(tx, workspaceId, plan);
        return receipt;
      });
    },
    /**
     * Pauses, resumes or stops the plan for its starter. Pause cancels running specialists, whose tasks start again on
     * resume; saved tasks keep running within their allowance. Resume may raise, never lower, the budget. Stop cancels
     * every unfinished task and pauses the saved tasks the plan started. Replaying a request returns its receipt.
     */
    async control(workspaceId: string, user: string, planId: string, input: unknown, sourceTurnId?: string) {
      const { requestId, ...command } = planControlSchema.parse(input);
      return transaction(workspaceId, user, true, async (tx, actor) => {
        const plan = await loadPlan(tx, actor, planId, true);
        requireStarter(plan, actor);
        const inputDigest = digest({ control: command });
        const prior = z
          .object({ input_digest: z.string(), receipt: planReceiptSchema })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT input_digest, receipt FROM ${relation(tx, 'tf_agent_plan_commands')} WHERE plan_id=$1 AND request_id=$2`,
                [plan.id, uuidSchema.parse(requestId)],
              )
            ).rows[0],
          );
        if (prior) {
          if (prior.input_digest !== inputDigest) throw new AgentPlanError('idempotency-conflict');
          return prior.receipt;
        }
        if (plan.lifecycle !== 'draft' && plan.lifecycle !== 'active' && plan.lifecycle !== 'paused')
          throw new AgentPlanError('plan-closed');
        if (plan.version !== command.expectedVersion) throw new AgentPlanError('version-conflict');
        if ((command.action === 'start') !== (plan.lifecycle === 'draft') && command.action !== 'stop')
          throw new PlanGraphError('invalid-transition');
        const rows = await loadTasks(tx, plan.id);
        const before = new Map(rows.map(row => [row.key, toNode(row)]));
        const after = rows.map(row => ({ ...toNode(row) }));
        const lifecycleChanges: unknown[] = [];
        let lifecycle: PlanRow['lifecycle'] = plan.lifecycle;
        if (command.action === 'pause') {
          lifecycle = 'paused';
          await pausePlanWork(tx, plan.id, after);
          lifecycleChanges.push({ op: 'lifecycle', to: 'paused', reason: 'starter' });
        } else if (command.action === 'resume' || command.action === 'start') {
          lifecycle = 'active';
          if (command.action === 'start')
            await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_plans')} SET execution='execute' WHERE id=$1`, [
              plan.id,
            ]);
          if (command.action === 'resume' && command.budget) {
            const budget = command.budget;
            if (
              budget.toolCalls < plan.budget.toolCalls ||
              budget.activeMilliseconds < plan.budget.activeMilliseconds ||
              budget.credits < plan.budget.credits
            )
              throw new AgentPlanError('budget-lowered');
            if (canonicalJson(budget) !== canonicalJson(plan.budget)) {
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_plans')} SET budget=$2 WHERE id=$1`, [
                plan.id,
                budget,
              ]);
              lifecycleChanges.push({ op: 'budget', from: plan.budget, to: budget });
            }
          }
          lifecycleChanges.push({ op: 'lifecycle', to: 'active' });
          if (plan.planning) {
            const turnId =
              sourceTurnId ??
              (
                await createConversations(boundRuntime(tx, workspaceId)).send(workspaceId, user, plan.chatId, {
                  commandId: requestId,
                  messageId: requestId,
                  mode: 'normal',
                  parts: [
                    {
                      kind: 'text',
                      text:
                        command.action === 'start'
                          ? `Start the saved plan: ${plan.title}.`
                          : `Resume the saved plan: ${plan.title}.`,
                    },
                  ],
                })
              ).turnId;
            const linked = await tx.client.query(
              `UPDATE ${relation(tx, 'tf_conversation_turns')} t SET plan_id=$2
              FROM ${relation(tx, 'tf_conversation_messages')} m WHERE t.id=$1 AND t.conversation_id=$3
                AND m.id=t.source_message_id AND m.conversation_id=t.conversation_id AND m.membership_id=$4 AND m.author_kind='human' AND NOT t.planning_mode`,
              [turnId, plan.id, plan.chatId, actor.membershipId],
            );
            if (!linked.rowCount) throw new AccessDenied();
          }
        } else {
          lifecycle = 'stopped';
          // A saved task created just before stop may not be linked yet; its start receipt is keyed by the attempt ID.
          const saved = z
            .array(z.object({ taskId: uuidSchema.nullable() }))
            .parse(
              (
                await tx.client.query(
                  `WITH cancelled AS (
              UPDATE ${relation(tx, 'tf_agent_plan_attempts')} SET status='cancelled', lease_until=NULL, settled_at=clock_timestamp()
              WHERE plan_id=$1 AND settled_at IS NULL RETURNING id, agent_task_id, specialist_key)
            SELECT COALESCE(c.agent_task_id, (r.receipt->>'id')::uuid) AS "taskId" FROM cancelled c
            LEFT JOIN ${relation(tx, 'tf_agent_task_commands')} r ON c.agent_task_id IS NULL AND c.specialist_key IS NULL AND r.membership_id=$2 AND r.request_id=c.id`,
                  [plan.id, plan.starterMembershipId],
                )
              ).rows,
            )
            .flatMap(row => (row.taskId ? [row.taskId] : []));
          if (saved.length) {
            const paused = await tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status='paused',pause_reason='plan' WHERE id=ANY($1::uuid[]) AND status<>'completed' AND status IS DISTINCT FROM 'paused'`,
              [saved],
            );
            taskTransition(tx, 'paused', paused.rowCount);
          }
          for (const node of after) {
            if (
              node.kind === 'work' &&
              node.state !== 'completed' &&
              node.state !== 'failed' &&
              node.state !== 'cancelled'
            ) {
              node.state = 'cancelled';
              node.reason = stoppedReason;
            }
          }
          lifecycleChanges.push({ op: 'lifecycle', to: 'stopped' });
        }
        const version = plan.version + 1;
        const changes = [...(await persist(tx, plan.id, version, before, after)), ...lifecycleChanges];
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plans')} SET lifecycle=$2, version=$3, updated_at=clock_timestamp() WHERE id=$1`,
          [plan.id, lifecycle, version],
        );
        if (command.action === 'pause' || command.action === 'stop') await wakePlanWait(tx, plan);
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_events')} (plan_id,version,actor,kind,changes) VALUES ($1,$2,'starter','controlled',$3)`,
          [plan.id, version, JSON.stringify(changes)],
        );
        const receipt = planReceiptSchema.parse({ id: plan.id, version, added: [], yielded: false });
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_commands')} (plan_id,request_id,input_digest,receipt) VALUES ($1,$2,$3,$4)`,
          [plan.id, requestId, inputDigest, receipt],
        );
        await notifyPlanChange(tx, workspaceId, plan);
        return receipt;
      });
    },
    /** Returns the read-only projection to anyone who can read the chat; only the starter receives `canControl`. */
    async read(workspaceId: string, user: string, planId: string) {
      return transaction(workspaceId, user, false, async (tx, actor) => {
        const plan = await loadPlan(tx, actor, planId, false);
        for (const check of plan.planning?.prerequisites ?? [])
          await requirePlanEvidence(tx, actor, plan, check.evidence, false);
        const projection = view(
          plan,
          await loadTasks(tx, plan.id),
          await loadSpecialists(tx, plan.id),
          actor,
          await pauseReason(tx, plan),
          await waitingTasks(tx, plan, actor),
        );
        const reports = z.array(z.object({ key: planKeySchema, report: planReportSchema })).parse(
          (
            await tx.client.query(
              `SELECT DISTINCT ON (task_key) task_key AS key,report FROM ${relation(tx, 'tf_agent_plan_attempts')}
          WHERE plan_id=$1 AND coordinator AND report IS NOT NULL ORDER BY task_key,generation DESC`,
              [plan.id],
            )
          ).rows,
        );
        for (const { key, report } of reports) {
          await requirePlanEvidence(
            tx,
            actor,
            plan,
            [...report.checks, ...report.requirements].flatMap(check => check.evidence),
            false,
          );
          const task = projection.tasks.find(task => task.key === key);
          if (task) task.report = report;
        }
        return projection;
      });
    },
    /**
     * Returns the latest completed result of each task, with the sources it depends on. Workers ran with the starter's
     * access, so only the starter receives results; a saved agent's result also depends on its private task.
     */
    async results(workspaceId: string, user: string, planId: string) {
      return transaction(workspaceId, user, false, async (tx, actor) => {
        const plan = await loadPlan(tx, actor, planId, false);
        requireStarter(plan, actor);
        const rows = z
          .array(
            z.object({
              key: planKeySchema,
              result: z.string(),
              sources: z.array(sourceDependencySchema),
              agentTaskId: uuidSchema.nullable(),
            }),
          )
          .parse(
            (
              await tx.client.query(
                `
          SELECT DISTINCT ON (task_key) task_key AS key, result, sources, agent_task_id AS "agentTaskId" FROM ${relation(tx, 'tf_agent_plan_attempts')}
          WHERE plan_id=$1 AND status='completed' AND result IS NOT NULL ORDER BY task_key, generation DESC`,
                [plan.id],
              )
            ).rows,
          );
        return rows.map(row => ({
          key: row.key,
          result: row.result,
          sources: row.agentTaskId
            ? [...row.sources, { kind: 'private-task' as const, taskId: row.agentTaskId }]
            : row.sources,
        }));
      });
    },
    /** Lists a chat's plans, newest first. */
    async list(workspaceId: string, user: string, chatId: string) {
      return transaction(workspaceId, user, false, async (tx, actor) => {
        await requireChat(tx, actor, chatId, 'read');
        const plans = z
          .array(planRowSchema)
          .parse(
            (
              await tx.client.query(
                `SELECT ${planColumns} FROM ${relation(tx, 'tf_agent_plans')} WHERE conversation_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50`,
                [chatId],
              )
            ).rows,
          );
        const items = [];
        for (const plan of plans)
          items.push(planListItemSchema.parse(view(plan, await loadTasks(tx, plan.id), [], actor)));
        return items;
      });
    },
  };
}
