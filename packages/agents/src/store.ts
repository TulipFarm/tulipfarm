import { randomUUID } from 'node:crypto';
import { withKnowledgeRetrieveGrant } from './knowledge-tool-contracts.ts';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
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
  maximumTaskLimits,
  scopeSchema,
  toolCallSchema,
} from './contracts.ts';
import { AgentError, replaceAgentActivationSchema } from './saved-contracts.ts';
import { requireHumanRun } from './internal-privacy.ts';
import { requireExternalRun, type ExternalRunGuard } from './external-run.ts';
import { resolveProcedures, resolveRunProcedures } from './workspace-skills.ts';
import { requirePersonalDefinitionSources } from './personal-definition-sources.ts';
import { isMcpCall } from './mcp-contracts.ts';
import { requireAgentGrant, requireAgentRunHistory, requireTeamAssignment } from '@tulipfarm/access';
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
  scope: scopeSchema,
  status: z.string(),
  task_id: uuidSchema.nullish(),
});
export const relation = (transaction: AgentTransaction, name: string) => qualified(transaction.schema, name);
const supportsReplacement = (transaction: AgentTransaction) =>
  'commonVersion' in transaction && Number(transaction.commonVersion) >= 59;
export const currentActivation = (transaction: AgentTransaction, alias = 'a') =>
  supportsReplacement(transaction) ? `${alias}.superseded_by_activation_id IS NULL` : 'true';

export async function resolveActivationId(transaction: AgentTransaction, id: string) {
  if (!supportsReplacement(transaction)) return id;
  const result = await transaction.client.query(
    `WITH RECURSIVE replacements AS (
      SELECT id,agent_id,superseded_by_activation_id,ARRAY[id] AS visited
      FROM ${relation(transaction, 'tf_agent_activations')} WHERE id=$1 AND revoked_at IS NULL
      UNION ALL
      SELECT a.id,a.agent_id,a.superseded_by_activation_id,r.visited || a.id
      FROM ${relation(transaction, 'tf_agent_activations')} a
      JOIN replacements r ON a.id=r.superseded_by_activation_id AND a.agent_id=r.agent_id
      WHERE a.revoked_at IS NULL AND NOT a.id=ANY(r.visited) AND cardinality(r.visited)<100
    ) SELECT id FROM replacements WHERE superseded_by_activation_id IS NULL`,
    [id],
  );
  if (!result.rows[0]) throw new AccessDenied();
  return uuidSchema.parse(result.rows[0].id);
}

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
        if (!existingTeams.includes(teamId)) await requireTeamAssignment(transaction, actor, teamId);
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

  async function replaceActivation(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = replaceAgentActivationSchema.extend({ agentId: uuidSchema }).parse(input);
    return mutation(workspaceId, actor, async transaction => {
      if (!supportsReplacement(transaction)) throw new AgentError('activation-replacement-unavailable', 503);
      await requireAgentPermission(transaction, actor, value.agentId, 'manage');
      const previous = (
        await transaction.client.query(
          `SELECT agent_id,definition_revision,scope,revoked_at FROM ${relation(transaction, 'tf_agent_activations')} WHERE id=$1`,
          [value.requestId],
        )
      ).rows[0];
      const agent = (
        await transaction.client.query(
          `SELECT a.saved_revision,a.policy_version,a.enabled,s.definition_revision
          FROM ${relation(transaction, 'tf_agents')} a
          JOIN ${relation(transaction, 'tf_agent_saved_revisions')} s ON s.agent_id=a.id AND s.soul_revision=a.saved_revision
          WHERE a.id=$1 AND a.deleted_at IS NULL FOR UPDATE OF a`,
          [value.agentId],
        )
      ).rows[0];
      if (
        !agent ||
        agent.saved_revision !== value.expectedSavedRevision ||
        agent.definition_revision !== value.revision ||
        agent.policy_version !== value.expectedPolicyVersion ||
        !agent.enabled
      )
        throw new AgentError('activation-version-conflict');
      const active = (
        await transaction.client.query(
          `SELECT id,scope FROM ${relation(transaction, 'tf_agent_activations')}
          WHERE agent_id=$1 AND revoked_at IS NULL AND superseded_by_activation_id IS NULL
          ORDER BY activated_at DESC NULLS LAST,id DESC`,
          [value.agentId],
        )
      ).rows;
      if (previous) {
        const replaced = (
          await transaction.client.query(
            `SELECT id FROM ${relation(transaction, 'tf_agent_activations')} WHERE agent_id=$1 AND superseded_by_activation_id=$2`,
            [value.agentId, value.requestId],
          )
        ).rows
          .map(row => row.id)
          .sort();
        if (
          previous.agent_id !== value.agentId ||
          previous.definition_revision !== value.revision ||
          canonicalJson(previous.scope) !== canonicalJson(value.scope) ||
          previous.revoked_at !== null ||
          active.length !== 1 ||
          active[0]?.id !== value.requestId ||
          canonicalJson(replaced) !== canonicalJson([...value.expectedActivationIds].sort())
        )
          throw new AgentError('activation-request-conflict');
        return { activationId: value.requestId };
      }
      if (canonicalJson(active.map(row => row.id).sort()) !== canonicalJson([...value.expectedActivationIds].sort()))
        throw new AgentError('activation-version-conflict');
      const scope =
        active[0]?.scope ??
        (
          await transaction.client.query(
            `SELECT scope FROM ${relation(transaction, 'tf_agent_limits')} WHERE agent_id=$1`,
            [value.agentId],
          )
        ).rows[0]?.scope ??
        [];
      if (canonicalJson(scope) !== canonicalJson(value.scope)) throw new AgentError('activation-scope-conflict');
      await resolveDefinitionProcedures(transaction, value.agentId, value.revision, actor);
      const before = await definitionRecommendationAudience(transaction, 'agent', value.agentId);
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_agent_activations')}(id,agent_id,definition_revision,scope) VALUES($1,$2,$3,$4)`,
        [value.requestId, value.agentId, value.revision, JSON.stringify(scope)],
      );
      await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agent_activations')} SET superseded_by_activation_id=$2,superseded_at=clock_timestamp()
        WHERE agent_id=$1 AND id=ANY($3::uuid[])`,
        [value.agentId, value.requestId, value.expectedActivationIds],
      );
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_audit_events')}(id,actor_id,operation,subject_id) VALUES($1,$2,'agent.activate',$3)`,
        [randomUUID(), actor.membershipId, value.agentId],
      );
      await recordDefinitionRecommendationChanges(transaction, 'agent', value.agentId, before);
      return { activationId: value.requestId };
    });
  }

  /**
   * Replaces the data an existing agent may use. Runs need an asset in the agent's limits and in the scope of
   * the activation they run under, so this updates the limits and re-activates the newest live revision with
   * the same scope. Anything not already in effect needs the editor's own access, as in setup.
   */
  async function changeDataScope(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = z
      .strictObject({ agentId: uuidSchema, version: z.number().int().nonnegative(), scope: scopeSchema })
      .parse(input);
    return mutation(workspaceId, actor, async transaction => {
      await requireAgentPermission(transaction, actor, value.agentId, 'manage');
      if (
        !(
          await transaction.client.query(
            `SELECT 1 FROM ${relation(transaction, 'tf_agents')} WHERE id = $1 AND saved_revision IS NOT NULL AND deleted_at IS NULL`,
            [value.agentId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      const limits = z
        .object({ scope: scopeSchema })
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT scope FROM ${relation(transaction, 'tf_agent_limits')} WHERE agent_id = $1`,
              [value.agentId],
            )
          ).rows[0],
        )?.scope;
      const active = z
        .object({ definition_revision: definitionRevisionSchema, scope: scopeSchema })
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT a.definition_revision, a.scope FROM ${relation(transaction, 'tf_agent_activations')} a WHERE a.agent_id = $1 AND a.revoked_at IS NULL AND ${currentActivation(transaction)} AND EXISTS (SELECT 1 FROM ${relation(transaction, 'tf_agent_saved_revisions')} s WHERE s.agent_id = a.agent_id AND s.definition_revision = a.definition_revision) ORDER BY a.activated_at DESC NULLS LAST, a.id DESC LIMIT 1`,
              [value.agentId],
            )
          ).rows[0],
        );
      const permits = (scope: z.infer<typeof scopeSchema> | undefined, assetId: string, permission: string) =>
        !!scope?.some(entry => entry.assetId === assetId && entry.permissions.some(item => item === permission));
      for (const entry of value.scope)
        for (const permission of entry.permissions) {
          const inEffect =
            permits(limits, entry.assetId, permission) && (!active || permits(active.scope, entry.assetId, permission));
          if (!inEffect && !(await canAccessAsset(transaction, actor, entry.assetId, permission)))
            throw new AccessDenied();
        }
      const before = await definitionRecommendationAudience(transaction, 'agent', value.agentId);
      const changed = await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agents')} SET policy_version = policy_version + 1 WHERE id = $1 AND policy_version = $2`,
        [value.agentId, value.version],
      );
      if (!changed.rowCount) throw new AgentError('policy-version-conflict');
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_agent_limits')} (agent_id, scope, task_limits) VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO UPDATE SET scope = EXCLUDED.scope`,
        [value.agentId, JSON.stringify(value.scope), JSON.stringify(maximumTaskLimits)],
      );
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.configure',$3)`,
        [randomUUID(), actor.membershipId, value.agentId],
      );
      // Older activations stay live for workflows that pin them; the limits above still narrow them.
      const reactivated = !!active && canonicalJson(active.scope) !== canonicalJson(value.scope);
      if (active && reactivated) {
        await resolveDefinitionProcedures(transaction, value.agentId, active.definition_revision);
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_activations')} (id, agent_id, definition_revision, scope) VALUES ($1, $2, $3, $4)`,
          [randomUUID(), value.agentId, active.definition_revision, JSON.stringify(value.scope)],
        );
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.activate',$3)`,
          [randomUUID(), actor.membershipId, value.agentId],
        );
      }
      await recordDefinitionRecommendationChanges(transaction, 'agent', value.agentId, before);
      return { saved: true as const, reactivated };
    });
  }

  async function revoke(workspaceId: string, actor: HumanActor, input: unknown) {
    const value = z.strictObject({ kind: z.enum(['activation', 'run']), id: uuidSchema }).parse(input);
    const tables = { activation: 'tf_agent_activations', run: 'tf_agent_runs' };
    return mutation(workspaceId, actor, async transaction => {
      let changedDefinition: { id: string; before: Map<string, string> } | undefined;
      if (value.kind === 'run') {
        const run = await loadRun(transaction, value.id);
        if (run.kind !== 'delegated' || run.membership_id !== actor.membershipId || run.user_id !== actor.userId)
          throw new AccessDenied();
      } else {
        const row = (
          await transaction.client.query(
            `SELECT agent_id FROM ${relation(transaction, 'tf_agent_activations')} WHERE id=$1`,
            [value.id],
          )
        ).rows[0];
        if (!row) throw new AccessDenied();
        await requireAgentPermission(transaction, actor, uuidSchema.parse(row.agent_id), 'manage');
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
      const activation = await liveActivation(
        transaction,
        task ? value.activationId : await resolveActivationId(transaction, value.activationId),
        actor,
      );
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
          : value.call.tool === 'api.request' ||
              value.call.tool === 'files.read' ||
              value.call.tool === 'secrets.request' ||
              value.call.tool === 'secrets.list'
            ? !run.task_id || run.kind !== 'delegated'
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
    replaceActivation,
    configure,
    changeDataScope,
    revoke,
    revokeActivation,
    queueCall,
    startDelegated: (workspaceId: string, actor: HumanActor, input: unknown) =>
      startDelegatedRun(workspaceId, actor, input),
    startTaskRun: (workspaceId: string, actor: HumanActor, input: unknown, task: { id: string; generation: number }) =>
      startDelegatedRun(workspaceId, actor, input, task),
  };
}
