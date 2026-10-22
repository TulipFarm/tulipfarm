import { randomUUID } from 'node:crypto';
import { withKnowledgeRetrieveGrant } from './knowledge-tool-contracts.ts';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireTaskInvocation,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import {
  agentDefinitionSchema,
  definitionRevisionSchema,
  executionPolicySchema,
  scopeSchema,
  toolCallSchema,
} from './contracts.ts';
import { AgentError } from './saved-contracts.ts';
import { requireHumanRun } from './internal-privacy.ts';
import { requireExternalRun, type ExternalRunGuard } from './external-run.ts';
import { resolveProcedures, resolveRunProcedures } from './workspace-skills.ts';
import { requirePersonalDefinitionSources } from './personal-definition-sources.ts';
import { isMcpCall } from './mcp-contracts.ts';
import { canAccessAsset, requireAgentGrant, requireAgentRunHistory, requireTeamManager } from '@tulipfarm/access';
import { requireAgentPermission } from './saved-policy.ts';
import { definitionRecommendationAudience, recordDefinitionRecommendationChanges } from './recommendations.ts';

export type AgentStorage = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export type AgentTransaction = AuthorizationTransaction;
export const agentCompatibility = commonCompatibility;
const activationSchema = z.object({
  id: uuidSchema,
  agent_id: uuidSchema,
  definition_revision: definitionRevisionSchema,
});
const runSchema = z.object({
  id: uuidSchema,
  agent_id: uuidSchema,
  activation_id: uuidSchema,
  definition_revision: definitionRevisionSchema,
  kind: z.enum(['delegated', 'scheduled']),
  user_id: z.string().nullable(),
  membership_id: uuidSchema.nullable(),
  schedule_id: uuidSchema.nullable(),
  scope: scopeSchema,
  status: z.string(),
  task_id: uuidSchema.nullish(),
});
export const relation = (transaction: AgentTransaction, name: string) => qualified(transaction.schema, name);

export function createAgentStore(storage: AgentStorage, externalGuard?: ExternalRunGuard) {
  async function mutation<T>(
    workspaceId: string,
    actor: HumanActor,
    operation: (transaction: AgentTransaction) => Promise<T>,
  ) {
    return storage.transaction(uuidSchema.parse(workspaceId), agentCompatibility, async transaction => {
      await lockAuthorization(transaction, 'write');
      await currentMember(transaction, actor);
      return operation(transaction);
    });
  }

  async function saveDefinition(workspaceId: string, actor: HumanActor, agentIdInput: string, input: unknown) {
    const agentId = uuidSchema.parse(agentIdInput);
    agentDefinitionSchema.parse(input);
    return mutation(workspaceId, actor, async transaction => {
      await requireAgentGrant(transaction, actor, agentId, 'manage');
      throw new AccessDenied();
    });
  }

  async function activate(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = z
      .strictObject({
        agentId: uuidSchema,
        revision: definitionRevisionSchema,
        scope: scopeSchema,
        requestId: uuidSchema.optional(),
      })
      .parse(input);
    return mutation(workspaceId, actor, async transaction => {
      await requireAgentPermission(transaction, actor, value.agentId, 'manage');
      const item = (
        await transaction.client.query(
          `SELECT saved_revision, deleted_at FROM ${relation(transaction, 'tf_agents')} WHERE id = $1`,
          [value.agentId],
        )
      ).rows[0];
      if (!item?.saved_revision || item.deleted_at) throw new AccessDenied();
      if (
        !(
          await transaction.client.query(
            `SELECT 1 FROM ${relation(transaction, 'tf_agent_saved_revisions')} WHERE agent_id = $1 AND definition_revision = $2`,
            [value.agentId, value.revision],
          )
        ).rowCount
      )
        throw new AccessDenied();
      await resolveDefinitionProcedures(transaction, value.agentId, value.revision);
      const id = value.requestId ?? randomUUID();
      const previous = (
        await transaction.client.query(
          `SELECT agent_id,definition_revision,scope,revoked_at FROM ${relation(transaction, 'tf_agent_activations')} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.agent_id !== value.agentId ||
          previous.definition_revision !== value.revision ||
          canonicalJson(previous.scope) !== canonicalJson(value.scope) ||
          previous.revoked_at !== null
        )
          throw new AgentError('activation-request-conflict');
        return { activationId: id };
      }
      const before = await definitionRecommendationAudience(transaction, 'agent', value.agentId);
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_agent_activations')} (id, agent_id, definition_revision, scope) VALUES ($1, $2, $3, $4)`,
        [id, value.agentId, value.revision, JSON.stringify(value.scope)],
      );
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.activate',$3)`,
        [randomUUID(), actor.membershipId, value.agentId],
      );
      await recordDefinitionRecommendationChanges(transaction, 'agent', value.agentId, before);
      return { activationId: id };
    });
  }

  async function configure(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = executionPolicySchema.extend({ agentId: uuidSchema }).parse(input);
    return mutation(workspaceId, actor, async transaction => {
      await requireAgentPermission(transaction, actor, value.agentId, 'manage');
      const before = await definitionRecommendationAudience(transaction, 'agent', value.agentId);
      const existingTeams = z
        .array(z.object({ team_id: uuidSchema }))
        .parse(
          (
            await transaction.client.query(
              `SELECT team_id FROM ${relation(transaction, 'tf_agent_teams')} WHERE agent_id=$1`,
              [value.agentId],
            )
          ).rows,
        )
        .map(row => row.team_id);
      for (const teamId of value.teamIds)
        if (!existingTeams.includes(teamId)) await requireTeamManager(transaction, actor, teamId);
      if (
        !(
          await transaction.client.query(
            `SELECT 1 FROM ${relation(transaction, 'tf_agents')} WHERE id = $1 AND saved_revision IS NOT NULL AND deleted_at IS NULL`,
            [value.agentId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      const changed = await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agents')} SET enabled = $2, policy_version = policy_version + 1 WHERE id = $1 AND policy_version = $3`,
        [value.agentId, value.enabled, value.version],
      );
      if (!changed.rowCount) throw new AgentError('policy-version-conflict');
      if (value.slackSender !== undefined) {
        const current = 'commonVersion' in transaction && Number(transaction.commonVersion) >= 1;
        if (!current && value.slackSender === 'app') throw new AgentError('slack-sender-unavailable');
        if (current)
          await transaction.client.query(
            `UPDATE ${relation(transaction, 'tf_agents')} SET slack_sender=$2 WHERE id=$1`,
            [value.agentId, value.slackSender],
          );
      }
      await transaction.client.query(`DELETE FROM ${relation(transaction, 'tf_agent_teams')} WHERE agent_id = $1`, [
        value.agentId,
      ]);
      for (const teamId of new Set(value.teamIds)) {
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_teams')} (agent_id, team_id) VALUES ($1, $2)`,
          [value.agentId, teamId],
        );
      }
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_agent_limits')} (agent_id, scope, task_limits) VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO UPDATE SET scope = EXCLUDED.scope, task_limits = EXCLUDED.task_limits`,
        [value.agentId, JSON.stringify(value.limits), JSON.stringify(value.taskLimits)],
      );
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.configure',$3)`,
        [randomUUID(), actor.membershipId, value.agentId],
      );
      await recordDefinitionRecommendationChanges(transaction, 'agent', value.agentId, before);
    });
  }

  async function authorizeSchedule(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = z.strictObject({ activationId: uuidSchema, scope: scopeSchema }).parse(input);
    return mutation(workspaceId, actor, async transaction => {
      const activation = await liveActivation(transaction, value.activationId, actor);
      await requireAgentPermission(transaction, actor, activation.agent_id, 'manage');
      await requireTaskInvocation(transaction, actor, activation.agent_id);
      for (const entry of value.scope)
        for (const permission of entry.permissions)
          if (!(await canAccessAsset(transaction, actor, entry.assetId, permission))) throw new AccessDenied();
      const id = randomUUID();
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_agent_schedules')} (id, activation_id, scope,sponsor_membership_id) VALUES ($1, $2, $3,$4)`,
        [id, value.activationId, JSON.stringify(value.scope), actor.membershipId],
      );
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_agent_schedule_audience')} (schedule_id,membership_id) VALUES ($1,$2)`,
        [id, actor.membershipId],
      );
      return { scheduleId: id };
    });
  }

  async function revoke(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = z.strictObject({ kind: z.enum(['activation', 'schedule', 'run']), id: uuidSchema }).parse(input);
    const tables = { activation: 'tf_agent_activations', schedule: 'tf_agent_schedules', run: 'tf_agent_runs' };
    return mutation(workspaceId, actor, async transaction => {
      let changedDefinition: { id: string; before: Map<string, string> } | undefined;
      if (value.kind === 'run') {
        const run = await loadRun(transaction, value.id);
        if (run.kind !== 'delegated' || run.membership_id !== actor.membershipId || run.user_id !== actor.userId)
          throw new AccessDenied();
      } else {
        const row = (
          await transaction.client.query(
            value.kind === 'activation'
              ? `SELECT agent_id FROM ${relation(transaction, 'tf_agent_activations')} WHERE id=$1`
              : `SELECT a.agent_id FROM ${relation(transaction, 'tf_agent_schedules')} s JOIN ${relation(transaction, 'tf_agent_activations')} a ON a.id=s.activation_id WHERE s.id=$1`,
            [value.id],
          )
        ).rows[0];
        if (!row) throw new AccessDenied();
        await requireAgentPermission(transaction, actor, uuidSchema.parse(row.agent_id), 'manage');
        if (value.kind === 'activation')
          changedDefinition = {
            id: row.agent_id,
            before: await definitionRecommendationAudience(transaction, 'agent', row.agent_id),
          };
      }
      const update = value.kind === 'run' ? "status = 'cancelled'" : 'revoked_at = now()';
      await transaction.client.query(
        `UPDATE ${relation(transaction, tables[value.kind])} SET ${update} WHERE id = $1`,
        [value.id],
      );
      if (changedDefinition)
        await recordDefinitionRecommendationChanges(
          transaction,
          'agent',
          changedDefinition.id,
          changedDefinition.before,
        );
    });
  }

  async function revokeActivation(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = z.strictObject({ agentId: uuidSchema, activationId: uuidSchema }).parse(input);
    return mutation(workspaceId, actor, async transaction => {
      await requireAgentPermission(transaction, actor, value.agentId, 'manage');
      const before = await definitionRecommendationAudience(transaction, 'agent', value.agentId);
      const changed = await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agent_activations')} SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND agent_id = $2`,
        [value.activationId, value.agentId],
      );
      if (!changed.rowCount) throw new AccessDenied();
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.activation.revoke',$3)`,
        [randomUUID(), actor.membershipId, value.activationId],
      );
      await recordDefinitionRecommendationChanges(transaction, 'agent', value.agentId, before);
      return { saved: true };
    });
  }

  async function liveActivation(transaction: AgentTransaction, id: string, actor?: HumanActor) {
    const rows = await transaction.client.query(
      `SELECT a.id, a.agent_id, a.definition_revision FROM ${relation(transaction, 'tf_agent_activations')} a JOIN ${relation(transaction, 'tf_agents')} g ON g.id = a.agent_id WHERE a.id = $1 AND a.revoked_at IS NULL AND g.enabled`,
      [id],
    );
    const activation = activationSchema.optional().parse(rows.rows[0]);
    if (!activation) throw new AccessDenied();
    if (
      !(
        await transaction.client.query(
          `SELECT 1 FROM ${relation(transaction, 'tf_agents')} a JOIN ${relation(transaction, 'tf_agent_saved_revisions')} s ON s.agent_id = a.id WHERE a.id = $1 AND a.saved_revision IS NOT NULL AND a.deleted_at IS NULL AND s.definition_revision = $2`,
          [activation.agent_id, activation.definition_revision],
        )
      ).rowCount
    )
      throw new AccessDenied();
    await resolveDefinitionProcedures(transaction, activation.agent_id, activation.definition_revision, actor);
    return activation;
  }

  async function resolveDefinitionProcedures(
    transaction: AgentTransaction,
    agentId: string,
    revision: string,
    actor?: HumanActor,
  ) {
    await requirePersonalDefinitionSources(transaction, [{ kind: 'agent-definition', agentId, revision }]);
    const row = (
      await transaction.client.query(
        `SELECT definition FROM ${relation(transaction, 'tf_agent_definitions')} WHERE agent_id=$1 AND revision=$2`,
        [agentId, revision],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    return resolveProcedures(transaction, agentDefinitionSchema.parse(row.definition).skills, actor);
  }

  async function startDelegatedRun(
    workspaceId: string,
    actor: HumanActor,
    input: unknown,
    task?: { id: string; generation: number },
  ) {
    const value = z.strictObject({ activationId: uuidSchema, scope: scopeSchema }).parse(input);
    return storage.transaction(uuidSchema.parse(workspaceId), agentCompatibility, async transaction => {
      await lockAuthorization(transaction);
      await currentMember(transaction, actor);
      const activation = await liveActivation(transaction, value.activationId, actor);
      if (task) await requireTaskInvocation(transaction, actor, activation.agent_id);
      const managed = await transaction.client.query(
        `SELECT 1 FROM ${relation(transaction, 'tf_agents')} WHERE id = $1 AND saved_revision IS NOT NULL`,
        [activation.agent_id],
      );
      if (!managed.rowCount) throw new AccessDenied();
      await requireTaskInvocation(transaction, actor, activation.agent_id);
      const id = randomUUID();
      if (task) {
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_runs')} (id, agent_id, activation_id, definition_revision, kind, user_id, membership_id, scope, task_id, task_generation) VALUES ($1, $2, $3, $4, 'delegated', $5, $6, $7, $8, $9)`,
          [
            id,
            activation.agent_id,
            activation.id,
            activation.definition_revision,
            actor.userId,
            actor.membershipId,
            JSON.stringify(value.scope),
            task.id,
            task.generation,
          ],
        );
        if (transaction.commonVersion >= 1)
          await transaction.client.query(
            `UPDATE ${relation(transaction, 'tf_agent_task_runs')} SET knowledge_root=(SELECT knowledge_root FROM ${relation(transaction, 'tf_agent_tasks')} WHERE id=$2) WHERE run_id=$1`,
            [id, task.id],
          );
      } else {
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_runs')} (id, agent_id, activation_id, definition_revision, kind, user_id, membership_id, scope) VALUES ($1, $2, $3, $4, 'delegated', $5, $6, $7)`,
          [
            id,
            activation.agent_id,
            activation.id,
            activation.definition_revision,
            actor.userId,
            actor.membershipId,
            JSON.stringify(value.scope),
          ],
        );
      }
      return { runId: id, revision: activation.definition_revision };
    });
  }

  async function startScheduled(workspaceId: string, input: unknown) {
    const value = z.strictObject({ scheduleId: uuidSchema, runId: uuidSchema }).parse(input);
    return storage.transaction(uuidSchema.parse(workspaceId), agentCompatibility, async transaction => {
      await lockAuthorization(transaction);
      const schedule = z
        .object({ activation_id: uuidSchema, scope: scopeSchema, membership_id: uuidSchema, user_id: z.string() })
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT s.activation_id,s.scope,m.id AS membership_id,m.user_id FROM ${relation(transaction, 'tf_agent_schedules')} s JOIN ${relation(transaction, 'tf_memberships')} m ON m.id=s.sponsor_membership_id AND m.removed_at IS NULL WHERE s.id = $1 AND s.revoked_at IS NULL AND s.paused_at IS NULL`,
              [value.scheduleId],
            )
          ).rows[0],
        );
      if (!schedule) throw new AccessDenied();
      const sponsor: HumanActor = { kind: 'human', membershipId: schedule.membership_id, userId: schedule.user_id };
      const activation = await liveActivation(transaction, schedule.activation_id, sponsor);
      await requireTaskInvocation(transaction, sponsor, activation.agent_id);
      const created = await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_agent_runs')} (id, agent_id, activation_id, definition_revision, kind, schedule_id, scope,sponsor_membership_id) VALUES ($1, $2, $3, $4, 'scheduled', $5, $6,$7) ON CONFLICT DO NOTHING`,
        [
          value.runId,
          activation.agent_id,
          activation.id,
          activation.definition_revision,
          value.scheduleId,
          JSON.stringify(schedule.scope),
          sponsor.membershipId,
        ],
      );
      const run = await loadRun(transaction, value.runId);
      if (created.rowCount)
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_run_audience')} (run_id,membership_id) SELECT $1,membership_id FROM ${relation(transaction, 'tf_agent_schedule_audience')} WHERE schedule_id=$2`,
          [value.runId, value.scheduleId],
        );
      if (run.kind !== 'scheduled' || run.schedule_id !== value.scheduleId || run.activation_id !== activation.id)
        throw new AccessDenied();
      return { runId: value.runId, revision: activation.definition_revision };
    });
  }

  async function loadRun(transaction: AgentTransaction, runId: string) {
    const run = runSchema
      .optional()
      .parse(
        (
          await transaction.client.query(`SELECT * FROM ${relation(transaction, 'tf_agent_runs')} WHERE id = $1`, [
            runId,
          ])
        ).rows[0],
      );
    if (!run || !['ready', 'running', 'waiting'].includes(run.status)) throw new AccessDenied();
    return run;
  }

  async function queueCall(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = z
      .strictObject({
        runId: uuidSchema,
        callId: uuidSchema,
        sequence: z.number().int().min(0).max(9999),
        call: toolCallSchema,
      })
      .parse(input);
    return storage.transaction(uuidSchema.parse(workspaceId), agentCompatibility, async transaction => {
      await lockAuthorization(transaction);
      await currentMember(transaction, actor);
      await requireHumanRun(transaction, value.runId);
      await requireExternalRun(transaction, workspaceId, value.runId, externalGuard);
      const run = await loadRun(transaction, value.runId);
      await requireAgentRunHistory(transaction, actor, run.id);
      if (
        run.kind === 'scheduled' &&
        !(
          await transaction.client.query(
            `SELECT 1 FROM ${relation(transaction, 'tf_agent_runs')} WHERE id=$1 AND sponsor_membership_id=$2`,
            [run.id, actor.membershipId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      if (run.task_id) await requireTaskInvocation(transaction, actor, run.agent_id);
      await liveActivation(transaction, run.activation_id, actor);
      await resolveRunProcedures(transaction, run.id);
      const definition = agentDefinitionSchema.parse(
        (
          await transaction.client.query(
            `SELECT definition FROM ${relation(transaction, 'tf_agent_definitions')} WHERE agent_id = $1 AND revision = $2`,
            [run.agent_id, run.definition_revision],
          )
        ).rows[0]?.definition,
      );
      const automaticSkillRead = value.call.tool === 'skills.read' && (definition.skills?.length ?? 0) > 0;
      if (
        isMcpCall(value.call)
          ? !run.task_id || run.kind !== 'delegated' || !definition.mcp?.length
          : !withKnowledgeRetrieveGrant(definition.tools).includes(value.call.tool) && !automaticSkillRead
      )
        throw new AccessDenied();
      if (value.call.tool === 'skills.read') {
        const call = value.call;
        const selected = definition.skills?.find(selection => selection.id === call.skillId);
        if (
          (automaticSkillRead || uuidSchema.safeParse(call.skillId).success) &&
          (!selected || selected.revision !== call.revision)
        )
          throw new AccessDenied();
        if (selected && call.revision !== undefined && selected.revision !== call.revision) throw new AccessDenied();
      }
      if (value.sequence > 0) {
        const predecessor = await transaction.client.query(
          `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id = $1 AND sequence = $2`,
          [run.id, value.sequence - 1],
        );
        if (!predecessor.rowCount) throw new Error('Tool sequence predecessor missing');
      }
      if (transaction.commonVersion >= 1)
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_tool_calls')} (id, run_id, sequence, call, knowledge_root) VALUES ($1, $2, $3, $4, (SELECT knowledge_root FROM ${relation(transaction, 'tf_agent_tasks')} WHERE id=$5)) ON CONFLICT DO NOTHING`,
          [value.callId, run.id, value.sequence, JSON.stringify(value.call), run.task_id ?? null],
        );
      else
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_tool_calls')} (id, run_id, sequence, call) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [value.callId, run.id, value.sequence, JSON.stringify(value.call)],
        );
      const saved = z
        .object({ run_id: uuidSchema, sequence: z.number(), call: toolCallSchema })
        .parse(
          (
            await transaction.client.query(
              `SELECT run_id, sequence, call FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE id = $1`,
              [value.callId],
            )
          ).rows[0],
        );
      if (
        saved.run_id !== run.id ||
        saved.sequence !== value.sequence ||
        canonicalJson(saved.call) !== canonicalJson(value.call)
      )
        throw new Error('Tool call identity conflict');
      return { callId: value.callId };
    });
  }

  return {
    saveDefinition,
    activate,
    configure,
    authorizeSchedule,
    revoke,
    revokeActivation,
    startScheduled,
    queueCall,
    startDelegated: (workspaceId: string, actor: HumanActor, input: unknown) =>
      startDelegatedRun(workspaceId, actor, input),
    startTaskRun: (workspaceId: string, actor: HumanActor, input: unknown, task: { id: string; generation: number }) =>
      startDelegatedRun(workspaceId, actor, input, task),
  };
}
