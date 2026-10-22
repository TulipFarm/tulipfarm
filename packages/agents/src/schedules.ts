import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
  lockAuthorization,
  requireTaskInvocation,
  uuidSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { calendarOccurrences, nextOccurrence } from '@tulipfarm/workflows/schedule';
import { calendarRangeSchema } from '@tulipfarm/workflows/calendar-contracts';
import { agentCalendarSchema } from './schedule-contracts.ts';
import { agentDefinitionSchema, executionIdsSchema, scopeSchema, toolCallSchema } from './contracts.ts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import {
  inspectionActivationSchema,
  scheduleInputSchema,
  scheduleLastRunSchema,
  scheduleSchema,
  taskScheduleMinimumMinutes,
  type ScheduleAction,
  type SchedulePauseReason,
  type ScheduleTrigger,
} from './schedule-contracts.ts';
import { AgentTaskError, taskLimitsSchema } from './task-contracts.ts';
import { createAgentTasks } from './tasks.ts';
import { boundRuntime } from './task-approval-gate.ts';
import { requireAgentPermission, withHuman } from './saved-policy.ts';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentError } from './saved-contracts.ts';
import { resolveProcedures, resolveRunProcedures } from './workspace-skills.ts';
import { requirePersonalDefinitionSources } from './personal-definition-sources.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { taskTelemetryCheckpoint, withTaskTelemetry } from './task-telemetry.ts';

type Transaction = AgentTransaction & { commonVersion: number };
/** Common migration 0008 adds tf_agent_tasks.schedule_id; an older workspace keeps inspection schedules only. */
const taskSchedulesInstalled = (tx: Transaction) => tx.commonVersion >= 1;
/** Common migration 0011 adds cron cadence columns and lets the runtime change either cadence. */
const calendarSchedulesInstalled = (tx: Transaction) => tx.commonVersion >= 1;
/** Inspection rows keep the tool call that `due` copies into tf_agent_tool_calls; a task row stores the saved prompt and limits. */
const storedCall = (action: ScheduleAction) =>
  action.kind === 'inspect' ? { tool: 'schema.inspect', tableId: action.tableId } : action;
const storedActionSchema = z.union([
  z
    .strictObject({ tool: z.literal('schema.inspect'), tableId: uuidSchema })
    .transform((call): ScheduleAction => ({ kind: 'inspect', tableId: call.tableId })),
  z.strictObject({ kind: z.literal('task'), text: z.string().min(1).max(8000), limits: taskLimitsSchema }),
]);
const listedSchema = z.object({
  call: storedActionSchema,
  inspectionStatus: z.string().nullable(),
  lastTask: scheduleLastRunSchema.nullable(),
});
const activeTaskStatuses = `('pending','waiting-clarification','waiting-approval')`;

function nextRun(trigger: ScheduleTrigger, now: Date) {
  try {
    const occurrence = nextOccurrence(trigger, now);
    if (!occurrence) throw new Error('not scheduled');
    return occurrence;
  } catch {
    throw new AgentError('schedule-invalid', 400);
  }
}

function taskCadenceAllowed(trigger: ScheduleTrigger) {
  if (trigger.kind === 'interval') return trigger.minutes >= taskScheduleMinimumMinutes;
  const first = new Date(nextRun(trigger, new Date('2024-01-01T00:00:00.000Z')));
  return new Date(nextRun(trigger, first)).getTime() - first.getTime() >= taskScheduleMinimumMinutes * 60000;
}

export function previewAgentTaskSchedule(trigger: ScheduleTrigger, now = new Date()) {
  if (!taskCadenceAllowed(trigger)) throw new AgentError('task-schedule-interval', 400);
  return { trigger, nextRunAt: nextRun(trigger, now) };
}

export function createAgentSchedules(runtime: AgentStorage) {
  runtime = withTaskTelemetry(runtime);
  async function activate(workspaceId: string, user: string, agentIdInput: string, value: unknown) {
    const agentId = uuidSchema.parse(agentIdInput);
    const input = inspectionActivationSchema.parse(value);
    return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
      await requireAgentPermission(tx, actor, agentId, 'manage');
      await requirePersonalDefinitionSources(tx, [{ kind: 'agent-definition', agentId, revision: input.revision }]);
      const definition = (
        await tx.client.query(
          `SELECT d.definition FROM ${relation(tx, 'tf_agent_saved_revisions')} s JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id = s.agent_id AND d.revision = s.definition_revision WHERE s.agent_id = $1 AND s.definition_revision = $2 LIMIT 1`,
          [agentId, input.revision],
        )
      ).rows[0]?.definition;
      if (!definition || !agentDefinitionSchema.parse(definition).tools.includes('schema.inspect'))
        throw new AccessDenied();
      await resolveProcedures(tx, agentDefinitionSchema.parse(definition).skills);
      const scope = [{ assetId: input.tableId, permissions: ['table.row.read'] }];
      const previous = (
        await tx.client.query(
          `SELECT agent_id, definition_revision, scope FROM ${relation(tx, 'tf_agent_activations')} WHERE id = $1`,
          [input.id],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.agent_id !== agentId ||
          previous.definition_revision !== input.revision ||
          JSON.stringify(scopeSchema.parse(previous.scope)) !== JSON.stringify(scope)
        )
          throw new AgentError('activation-identity-conflict');
        return { activationId: input.id };
      }
      const configured = (
        await tx.client.query(
          `SELECT a.enabled, l.scope FROM ${relation(tx, 'tf_agents')} a JOIN ${relation(tx, 'tf_agent_limits')} l ON l.agent_id=a.id WHERE a.id=$1`,
          [agentId],
        )
      ).rows[0];
      if (
        !configured?.enabled ||
        !scopeSchema
          .parse(configured.scope)
          .some(item => item.assetId === input.tableId && item.permissions.includes('table.row.read'))
      )
        throw new AgentError('configure-agent-read-limits-first', 400);
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,$4)`,
        [input.id, agentId, input.revision, JSON.stringify(scope)],
      );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'agent.inspection.activate',$3)`,
        [randomUUID(), actor.membershipId, agentId],
      );
      return { activationId: input.id };
    });
  }
  async function list(workspaceId: string, user: string, agentId: string) {
    return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
      await requireAgentPermission(tx, actor, agentId, 'manage');
      const lastTask = taskSchedulesInstalled(tx)
        ? `(SELECT result FROM (
        SELECT json_build_object('kind', 'task', 'taskId', t.id, 'status', t.status) AS result, t.created_at, t.id
        FROM ${relation(tx, 'tf_agent_tasks')} t WHERE t.schedule_id=s.id AND t.owner_membership_id=$2
        UNION ALL
        SELECT json_build_object('kind', 'skipped', 'reason', substr(e.operation, length('agent.schedule.skip.') + 1)), e.created_at, e.id
        FROM ${relation(tx, 'tf_audit_events')} e WHERE e.subject_id=s.id AND e.actor_id=($2::uuid)::text AND e.operation LIKE 'agent.schedule.skip.%'
      ) attempts ORDER BY created_at DESC, id DESC LIMIT 1)`
        : 'NULL::json';
      const calendar = calendarSchedulesInstalled(tx);
      const pauseReason = `(CASE WHEN s.paused_at IS NOT NULL THEN (SELECT CASE e.operation WHEN 'agent.schedule.pause.sponsor-access-lost' THEN 'sponsor-access-lost' WHEN 'agent.schedule.pause.scheduled-call-denied' THEN 'scheduled-call-denied' END FROM ${relation(tx, 'tf_audit_events')} e WHERE e.subject_id=s.id AND e.operation LIKE 'agent.schedule.pause.%' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) END)`;
      const rows = (
        await tx.client.query(
          `SELECT s.id, s.activation_id AS "activationId", s.call, s.interval_minutes AS "intervalMinutes", ${calendar ? 's.cron_expression AS "cronExpression",s.timezone' : 'NULL::text AS "cronExpression",NULL::text AS timezone'}, a.definition_revision AS revision, s.next_run_at::text AS "nextRunAt", (s.revoked_at IS NOT NULL) AS revoked, (s.paused_at IS NOT NULL) AS paused, ${pauseReason} AS "pauseReason", s.sponsor_membership_id AS "sponsorMembershipId", ARRAY(SELECT membership_id FROM ${relation(tx, 'tf_agent_schedule_audience')} WHERE schedule_id=s.id ORDER BY membership_id) AS "historyAudience", (g.enabled AND a.revoked_at IS NULL AND s.paused_at IS NULL) AS enabled, (SELECT c.status FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_run_audience')} audience ON audience.run_id=r.id AND audience.membership_id=$2 JOIN ${relation(tx, 'tf_agent_tool_calls')} c ON c.run_id = r.id WHERE r.schedule_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS "inspectionStatus", ${lastTask} AS "lastTask" FROM ${relation(tx, 'tf_agent_schedules')} s JOIN ${relation(tx, 'tf_agent_activations')} a ON a.id = s.activation_id JOIN ${relation(tx, 'tf_agents')} g ON g.id=a.agent_id WHERE a.agent_id = $1 AND (s.interval_minutes IS NOT NULL${calendar ? ' OR s.cron_expression IS NOT NULL' : ''}) ORDER BY (a.revoked_at IS NULL AND s.revoked_at IS NULL) DESC, s.id LIMIT 100`,
          [agentId, actor.membershipId],
        )
      ).rows;
      return z.array(scheduleSchema).parse(
        rows.map(({ call, inspectionStatus, lastTask, intervalMinutes, cronExpression, timezone, ...schedule }) => {
          const listed = listedSchema.parse({ call, inspectionStatus, lastTask });
          const lastRun =
            listed.call.kind === 'inspect'
              ? listed.inspectionStatus === null
                ? null
                : { kind: 'inspection', status: listed.inspectionStatus }
              : listed.lastTask;
          return {
            ...schedule,
            action: listed.call,
            trigger:
              intervalMinutes === null
                ? { kind: 'cron', expression: cronExpression, timezone }
                : { kind: 'interval', minutes: intervalMinutes },
            lastRun,
          };
        }),
      );
    });
  }
  async function calendar(workspaceId: string, user: string, value: unknown) {
    const range = calendarRangeSchema.parse(value);
    return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
      const rows = (
        await tx.client.query(
          `SELECT s.id,a.agent_id AS "agentId",g.display_name AS name,s.interval_minutes AS minutes,
        ${calendarSchedulesInstalled(tx) ? 's.cron_expression AS expression,s.timezone' : 'NULL AS expression,NULL AS timezone'},s.next_run_at::text AS "nextRunAt"
        FROM ${relation(tx, 'tf_agent_schedules')} s JOIN ${relation(tx, 'tf_agent_activations')} a ON a.id=s.activation_id JOIN ${relation(tx, 'tf_agents')} g ON g.id=a.agent_id
        WHERE s.revoked_at IS NULL AND s.paused_at IS NULL AND a.revoked_at IS NULL AND g.enabled
        AND (s.sponsor_membership_id=$1 OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_schedule_audience')} v WHERE v.schedule_id=s.id AND v.membership_id=$1))
        ORDER BY s.id LIMIT 101`,
          [actor.membershipId],
        )
      ).rows;
      const schedules: z.infer<typeof agentCalendarSchema>['schedules'] = [];
      for (const row of rows.slice(0, 100)) {
        try {
          await requireAgentPermission(tx, actor, row.agentId, 'read');
        } catch (error) {
          if (error instanceof AccessDenied) continue;
          throw error;
        }
        const trigger =
          row.minutes === null
            ? {
                kind: 'cron' as const,
                expression: z.string().parse(row.expression),
                timezone: z.string().parse(row.timezone),
              }
            : { kind: 'interval' as const, minutes: z.number().int().positive().parse(row.minutes) };
        schedules.push({
          id: row.id,
          agentId: row.agentId,
          name: row.name,
          ...calendarOccurrences(trigger, row.nextRunAt, range.from, range.to),
        });
      }
      return agentCalendarSchema.parse({
        schedules,
        more: rows.length > 100 || schedules.some(schedule => schedule.more),
      });
    });
  }
  async function save(workspaceId: string, user: string, agentId: string, value: unknown) {
    const input = scheduleInputSchema.parse(value);
    const { action } = input;
    return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
      await requireAgentPermission(tx, actor, agentId, 'manage');
      if (input.sponsorMembershipId !== actor.membershipId) throw new AccessDenied();
      await requireTaskInvocation(tx, actor, agentId);
      if (action.kind === 'task') {
        if (!taskSchedulesInstalled(tx)) throw new AgentError('task-schedule-unavailable');
        if (!taskCadenceAllowed(input.trigger)) throw new AgentError('task-schedule-interval', 400);
        // Task history is readable only by its owner, so no one else may be named as an audience.
        if (input.historyAudience.length) throw new AgentError('task-schedule-history-private', 400);
      }
      const activation = (
        await tx.client.query(
          `SELECT a.scope, d.definition, EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_saved_revisions')} r WHERE r.agent_id=a.agent_id AND r.definition_revision=a.definition_revision) AS saved FROM ${relation(tx, 'tf_agent_activations')} a JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id = a.agent_id AND d.revision = a.definition_revision JOIN ${relation(tx, 'tf_agents')} g ON g.id = a.agent_id WHERE a.id = $1 AND a.agent_id = $2 AND a.revoked_at IS NULL AND g.enabled`,
          [input.activationId, agentId],
        )
      ).rows[0];
      if (!activation) throw new AccessDenied();
      const definition = agentDefinitionSchema.parse(activation.definition),
        activationScope = scopeSchema.parse(activation.scope);
      if (
        action.kind === 'inspect' &&
        (!definition.tools.includes('schema.inspect') ||
          !activationScope.some(item => item.assetId === action.tableId && item.permissions.includes('table.row.read')))
      )
        throw new AccessDenied();
      if (action.kind === 'task' && activation.saved !== true) throw new AccessDenied();
      const scope: z.infer<typeof scopeSchema> =
        action.kind === 'inspect' ? [{ assetId: action.tableId, permissions: ['table.row.read'] }] : activationScope;
      const requireScope = async (person: HumanActor) => {
        for (const entry of scope)
          for (const permission of entry.permissions)
            if (!(await canAccessAsset(tx, person, entry.assetId, permission))) throw new AccessDenied();
      };
      await requireScope(actor);
      for (const membershipId of input.historyAudience) {
        const member = (
          await tx.client.query(
            `SELECT user_id FROM ${relation(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
            [membershipId],
          )
        ).rows[0];
        if (!member) throw new AccessDenied();
        const recipient: HumanActor = { kind: 'human', membershipId, userId: z.string().parse(member.user_id) };
        await requireAgentPermission(tx, recipient, agentId, 'invoke');
        await requireScope(recipient);
      }
      await requirePersonalDefinitionSources(tx, [
        { kind: 'agent-definition', agentId, revision: 'all-saved-revisions' },
      ]);
      await resolveProcedures(tx, definition.skills, actor);
      const call = storedCall(action);
      if (input.trigger.kind === 'cron' && !calendarSchedulesInstalled(tx))
        throw new AgentError('schedule-calendar-unavailable');
      const calendar = calendarSchedulesInstalled(tx);
      const previous = (
        await tx.client.query(
          `SELECT activation_id, interval_minutes, ${calendar ? 'cron_expression,timezone' : 'NULL::text AS cron_expression,NULL::text AS timezone'}, call, revoked_at FROM ${relation(tx, 'tf_agent_schedules')} WHERE id = $1`,
          [input.id],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.activation_id !== input.activationId ||
          (previous.interval_minutes === null && previous.cron_expression === null) ||
          previous.call === null ||
          canonicalJson(previous.call) !== canonicalJson(call)
        )
          throw new AgentError('schedule-identity-conflict');
        const priorTrigger =
          previous.interval_minutes === null
            ? { kind: 'cron' as const, expression: previous.cron_expression, timezone: previous.timezone }
            : { kind: 'interval' as const, minutes: previous.interval_minutes };
        if (canonicalJson(priorTrigger) !== canonicalJson(input.trigger)) {
          if (previous.revoked_at !== null || (!calendar && input.trigger.kind === 'cron'))
            throw new AgentError('schedule-identity-conflict');
          const nextRunAt = nextRun(input.trigger, new Date());
          if (calendar)
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_schedules')} SET interval_minutes=$2,cron_expression=$3,timezone=$4,next_run_at=$5 WHERE id=$1`,
              [
                input.id,
                input.trigger.kind === 'interval' ? input.trigger.minutes : null,
                input.trigger.kind === 'cron' ? input.trigger.expression : null,
                input.trigger.kind === 'cron' ? input.trigger.timezone : null,
                nextRunAt,
              ],
            );
          else
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_schedules')} SET interval_minutes=$2,next_run_at=$3 WHERE id=$1`,
              [input.id, input.trigger.kind === 'interval' ? input.trigger.minutes : null, nextRunAt],
            );
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'agent.schedule.trigger',$3)`,
            [randomUUID(), actor.membershipId, input.id],
          );
        }
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_schedules')} SET sponsor_membership_id=$2,paused_at=NULL WHERE id=$1 AND revoked_at IS NULL`,
          [input.id, actor.membershipId],
        );
        await tx.client.query(`DELETE FROM ${relation(tx, 'tf_agent_schedule_audience')} WHERE schedule_id=$1`, [
          input.id,
        ]);
        for (const membershipId of new Set(input.historyAudience))
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_schedule_audience')} (schedule_id,membership_id) VALUES ($1,$2)`,
            [input.id, membershipId],
          );
        return { saved: true };
      }
      const count = (
        await tx.client.query(
          `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_agent_schedules')} s JOIN ${relation(tx, 'tf_agent_activations')} a ON a.id=s.activation_id WHERE a.agent_id=$1 AND a.revoked_at IS NULL AND s.revoked_at IS NULL`,
          [agentId],
        )
      ).rows[0]?.count;
      if (z.number().parse(count) >= 100) throw new AgentError('schedule-limit-reached', 400);
      const nextRunAt = nextRun(input.trigger, new Date());
      if (calendar)
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_schedules')} (id, activation_id, scope, interval_minutes, cron_expression, timezone, call, next_run_at,sponsor_membership_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.id,
            input.activationId,
            JSON.stringify(scope),
            input.trigger.kind === 'interval' ? input.trigger.minutes : null,
            input.trigger.kind === 'cron' ? input.trigger.expression : null,
            input.trigger.kind === 'cron' ? input.trigger.timezone : null,
            JSON.stringify(call),
            nextRunAt,
            actor.membershipId,
          ],
        );
      else
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_schedules')} (id, activation_id, scope, interval_minutes, call, next_run_at,sponsor_membership_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.id,
            input.activationId,
            JSON.stringify(scope),
            input.trigger.kind === 'interval' ? input.trigger.minutes : null,
            JSON.stringify(call),
            nextRunAt,
            actor.membershipId,
          ],
        );
      for (const membershipId of new Set(input.historyAudience))
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_schedule_audience')} (schedule_id,membership_id) VALUES ($1,$2)`,
          [input.id, membershipId],
        );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'agent.schedule.create',$3)`,
        [randomUUID(), actor.membershipId, input.id],
      );
      return { saved: true };
    });
  }
  async function revoke(workspaceId: string, user: string, agentId: string, id: string) {
    return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
      await requireAgentPermission(tx, actor, agentId, 'manage');
      const changed = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_schedules')} s SET revoked_at = COALESCE(s.revoked_at, now()) FROM ${relation(tx, 'tf_agent_activations')} a WHERE s.id = $1 AND s.activation_id = a.id AND a.agent_id = $2 RETURNING s.id`,
        [z.uuid().parse(id), agentId],
      );
      if (!changed.rowCount) throw new AccessDenied();
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'agent.schedule.revoke',$3)`,
        [randomUUID(), actor.membershipId, id],
      );
      return { saved: true };
    });
  }
  async function due(workspaceId: string, wakeTask?: (workspaceId: string, taskId: string) => Promise<void>) {
    const taskIds: string[] = [];
    const result = await runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const pause = async (id: string, reason: SchedulePauseReason, sponsorMembershipId?: string) => {
        const changed = await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_schedules')} SET paused_at=clock_timestamp() WHERE id=$1 AND paused_at IS NULL AND revoked_at IS NULL AND ($2::uuid IS NULL OR sponsor_membership_id=$2) RETURNING id`,
          [id, sponsorMembershipId ?? null],
        );
        if (changed.rowCount)
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id,created_at) VALUES ($1,'system:agent-schedule-sweep',$2,$3,clock_timestamp())`,
            [randomUUID(), `agent.schedule.pause.${reason}`, id],
          );
      };
      const missingSponsors = (
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_schedules')} s SET paused_at=clock_timestamp() WHERE s.paused_at IS NULL AND s.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_memberships')} m WHERE m.id=s.sponsor_membership_id AND m.removed_at IS NULL) RETURNING s.id`,
        )
      ).rows;
      for (const schedule of missingSponsors)
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id,created_at) VALUES ($1,'system:agent-schedule-sweep','agent.schedule.pause.sponsor-access-lost',$2,clock_timestamp())`,
          [randomUUID(), schedule.id],
        );
      // One task per schedule runs at a time; a paused, failed or completed task lets the next occurrence start.
      const taskRunning = taskSchedulesInstalled(tx)
        ? `EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_tasks')} t WHERE t.schedule_id = s.id AND t.status IN ${activeTaskStatuses})`
        : 'false';
      const calendar = calendarSchedulesInstalled(tx);
      const rows = (
        await tx.client.query(
          `SELECT s.id, s.activation_id, s.scope, s.call, s.interval_minutes, ${calendar ? 's.cron_expression,s.timezone' : 'NULL::text AS cron_expression,NULL::text AS timezone'}, now() AS "now", a.agent_id, a.definition_revision,m.id AS membership_id,m.user_id FROM ${relation(tx, 'tf_agent_schedules')} s JOIN ${relation(tx, 'tf_agent_activations')} a ON a.id = s.activation_id JOIN ${relation(tx, 'tf_agents')} g ON g.id = a.agent_id JOIN ${relation(tx, 'tf_memberships')} m ON m.id=s.sponsor_membership_id AND m.removed_at IS NULL WHERE s.revoked_at IS NULL AND s.paused_at IS NULL AND a.revoked_at IS NULL AND g.enabled AND s.next_run_at <= now() AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_tool_calls')} c ON c.run_id = r.id WHERE r.schedule_id = s.id AND c.status IN ('pending','waiting')) AND NOT ${taskRunning} ORDER BY s.next_run_at, s.id LIMIT 20`,
        )
      ).rows;
      const tasks = createAgentTasks(boundRuntime(tx, workspaceId));
      for (const row of rows) {
        const sponsor: HumanActor = {
          kind: 'human',
          membershipId: uuidSchema.parse(row.membership_id),
          userId: z.string().parse(row.user_id),
        };
        const scope = scopeSchema.parse(row.scope),
          action = storedActionSchema.parse(row.call);
        try {
          await requireAgentPermission(tx, sponsor, uuidSchema.parse(row.agent_id), 'invoke');
          for (const entry of scope)
            for (const permission of entry.permissions)
              if (!(await canAccessAsset(tx, sponsor, entry.assetId, permission))) throw new AccessDenied();
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          await pause(row.id, 'sponsor-access-lost');
          continue;
        }
        if (action.kind === 'task') {
          await tx.client.query('SAVEPOINT due_task_schedule');
          const rollbackTelemetry = taskTelemetryCheckpoint(tx);
          try {
            const task = await tasks.startScheduled(workspaceId, sponsor.userId, {
              scheduleId: row.id,
              agentId: row.agent_id,
              activationId: row.activation_id,
              scope,
              limits: action.limits,
              text: action.text,
            });
            await tx.client.query('RELEASE SAVEPOINT due_task_schedule');
            taskIds.push(task.id);
          } catch (error) {
            if (!(error instanceof AccessDenied) && !(error instanceof AgentTaskError)) throw error;
            await tx.client.query('ROLLBACK TO SAVEPOINT due_task_schedule');
            rollbackTelemetry();
            await tx.client.query('RELEASE SAVEPOINT due_task_schedule');
            // Lost access pauses the schedule; a refused start, such as the sponsor's task limit, skips only this occurrence.
            if (error instanceof AccessDenied) {
              await pause(row.id, 'sponsor-access-lost');
              continue;
            }
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id,created_at) VALUES ($1,$2,$3,$4,clock_timestamp())`,
              [randomUUID(), sponsor.membershipId, `agent.schedule.skip.${error.code}`, row.id],
            );
          }
        } else {
          const runId = randomUUID();
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,schedule_id,scope,sponsor_membership_id) VALUES ($1,$2,$3,$4,'scheduled',$5,$6,$7)`,
            [
              runId,
              row.agent_id,
              row.activation_id,
              row.definition_revision,
              row.id,
              JSON.stringify(scope),
              sponsor.membershipId,
            ],
          );
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_run_audience')} (run_id,membership_id) SELECT $1,membership_id FROM ${relation(tx, 'tf_agent_schedule_audience')} WHERE schedule_id=$2`,
            [runId, row.id],
          );
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_tool_calls')} (id,run_id,sequence,call) VALUES ($1,$2,0,$3)`,
            [randomUUID(), runId, JSON.stringify(toolCallSchema.parse(row.call))],
          );
        }
        const trigger =
          row.interval_minutes === null
            ? { kind: 'cron' as const, expression: row.cron_expression, timezone: row.timezone }
            : { kind: 'interval' as const, minutes: row.interval_minutes };
        await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_schedules')} SET next_run_at=$2 WHERE id=$1`, [
          row.id,
          nextRun(trigger, new Date(row.now)),
        ]);
      }
      const pending = (
        await tx.client.query(
          `SELECT r.id AS "runId", r.sponsor_membership_id AS "sponsorMembershipId", c.id AS "callId", s.id AS "scheduleId" FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_tool_calls')} c ON c.run_id = r.id JOIN ${relation(tx, 'tf_agent_schedules')} s ON s.id=r.schedule_id WHERE r.kind = 'scheduled' AND c.status IN ('pending','waiting') ORDER BY s.dispatched_at NULLS FIRST, r.created_at, c.id LIMIT 20`,
        )
      ).rows;
      const result = [];
      for (const row of pending) {
        const ids = executionIdsSchema.parse({ workspaceId, runId: row.runId, callId: row.callId });
        await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_schedules')} SET dispatched_at=now() WHERE id=$1`, [
          z.uuid().parse(row.scheduleId),
        ]);
        try {
          await resolveRunProcedures(tx, ids.runId);
          result.push(ids);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status = 'blocked' WHERE id = $1`, [
            ids.callId,
          ]);
          await pause(
            z.uuid().parse(row.scheduleId),
            'scheduled-call-denied',
            uuidSchema.parse(row.sponsorMembershipId),
          );
        }
      }
      return result;
    });
    for (const taskId of taskIds) await wakeTask?.(workspaceId, taskId);
    return result;
  }
  return { activate, list, calendar, save, revoke, due };
}
