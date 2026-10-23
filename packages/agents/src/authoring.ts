import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, humanActorSchema, requireNoMcpDerived, uuidSchema, type HumanActor } from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { trackEvent } from '@tulipfarm/observability';
import { afterCommit } from '@tulipfarm/workspace-storage/runtime';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentError, agentProjectionSchema, saveAgentSchema, soulRevisionSchema } from './saved-contracts.ts';
import { requireAgentCreation, requireAgentPermission, savedAgentCompatibility, withHuman } from './saved-policy.ts';
import type { ModelFamilyEligibility } from './model-policy-contracts.ts';
import { modelFamilyEnabled } from './model-availability.ts';
import { requireCommandDraftSources } from './draft-sources.ts';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { requireSharedMcpSlots } from '@tulipfarm/access';
import { deletedSkillPins, resolveProcedures } from './workspace-skills.ts';

const commandSchema = z.object({
  id: uuidSchema,
  agent_id: uuidSchema,
  membership_id: uuidSchema,
  user_id: z.string(),
  input: saveAgentSchema,
  status: z.enum(['preparing', 'accepted', 'conflict', 'failed']),
  created_at: z.date(),
  accepted_revision: soulRevisionSchema.nullable(),
});
type Command = z.infer<typeof commandSchema>;
export type PrepareAgentRevision = (input: {
  workspaceId: string;
  commandId: string;
  expectedParentCommit: string;
  createdAt: string;
  definition: z.infer<typeof saveAgentSchema>['definition'] & { formatVersion: 1; id: string };
  parent: { key: string; sha256: string } | null;
}) => Promise<{
  parentCommit: string;
  commit: string;
  bundle: { key: string; sha256: string };
  projection: z.infer<typeof agentProjectionSchema>;
}>;
const result = (command: Command) => ({
  commandId: command.id,
  agentId: command.agent_id,
  status: command.status,
  savedRevision: command.accepted_revision,
});
const actorOf = (command: Command): HumanActor => ({
  kind: 'human',
  membershipId: command.membership_id,
  userId: command.user_id,
});

async function authorize(
  transaction: AgentTransaction,
  actor: HumanActor,
  command: Pick<Command, 'agent_id' | 'input'>,
) {
  await requireSharedMcpSlots(transaction, command.input.definition);
  await resolveProcedures(transaction, command.input.definition.skills, actor);
  await requireNoMcpDerived(
    transaction,
    (command.input.definition.skills ?? [])
      .filter(skill => uuidSchema.safeParse(skill.id).success)
      .map(skill => ({ kind: 'workspace-skill', skillId: skill.id, revision: skill.revision })),
  );
  if (command.input.expectedSavedRevision === null)
    await requireAgentCreation(transaction, actor, command.input.owningTeamId);
  else await requireAgentPermission(transaction, actor, command.agent_id, 'edit');
}

async function changesFamily(transaction: AgentTransaction, agentId: string, familyId: string) {
  const current = (
    await transaction.client.query(
      `SELECT d.definition->>'modelFamilyId' AS model_family_id FROM ${relation(transaction, 'tf_agents')} a JOIN ${relation(transaction, 'tf_agent_saved_revisions')} s ON s.agent_id = a.id AND s.soul_revision = a.saved_revision JOIN ${relation(transaction, 'tf_agent_definitions')} d ON d.agent_id = s.agent_id AND d.revision = s.definition_revision WHERE a.id = $1`,
      [agentId],
    )
  ).rows[0];
  return current?.model_family_id !== familyId;
}

export function createAgentAuthoring(runtime: AgentStorage, eligible: ModelFamilyEligibility = () => false) {
  async function save(workspaceId: string, user: string | HumanActor, agentIdInput: string, value: unknown) {
    workspaceId = uuidSchema.parse(workspaceId);
    user = typeof user === 'string' ? user : humanActorSchema.parse(user);
    const agentId = uuidSchema.parse(agentIdInput);
    const input = saveAgentSchema.parse(value);
    return withHuman(runtime, workspaceId, user, 'read', async (transaction, actor) => {
      await authorize(transaction, actor, { agent_id: agentId, input });
      if (await deletedSkillPins(transaction, input.definition.skills ?? [])) throw new AgentError('skill-deleted');
      const head = (
        await transaction.client.query(
          `SELECT revision FROM ${relation(transaction, 'tf_soul_head')} WHERE id = 1 FOR UPDATE`,
        )
      ).rows[0];
      const existing = commandSchema
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT * FROM ${relation(transaction, 'tf_agent_commands')} WHERE membership_id = $1 AND request_id = $2`,
              [actor.membershipId, input.requestId],
            )
          ).rows[0],
        );
      if (existing) {
        if (existing.agent_id !== agentId || canonicalJson(existing.input) !== canonicalJson(input))
          throw new AgentError('idempotency-conflict');
        return result(existing);
      }
      if (head?.revision !== input.expectedSoulRevision) throw new AgentError('soul-head-conflict');
      const item = (
        await transaction.client.query(
          `SELECT saved_revision, owning_team_id, deleted_at FROM ${relation(transaction, 'tf_agents')} WHERE id = $1`,
          [agentId],
        )
      ).rows[0];
      if (
        input.expectedSavedRevision === null
          ? Boolean(item)
          : !item ||
            item.saved_revision !== input.expectedSavedRevision ||
            item.owning_team_id !== input.owningTeamId ||
            item.deleted_at
      )
        throw new AgentError('saved-revision-conflict');
      if (input.definition.modelFamilyId !== undefined) {
        if (await changesFamily(transaction, agentId, input.definition.modelFamilyId)) {
          if (!(await modelFamilyEnabled(transaction, input.definition.modelFamilyId)))
            throw new AgentError('workspace-disabled', 400);
          if (!(await eligible({ workspaceId, modelFamilyId: input.definition.modelFamilyId })))
            throw new AgentError('model-family-unavailable', 400);
        }
      }
      const command = commandSchema.parse(
        (
          await transaction.client.query(
            `INSERT INTO ${relation(transaction, 'tf_agent_commands')} (id, agent_id, membership_id, user_id, request_id, input) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [randomUUID(), agentId, actor.membershipId, actor.userId, input.requestId, input],
          )
        ).rows[0],
      );
      afterCommit(transaction.client, () =>
        trackEvent(
          'agent_save_requested',
          { userId: actor.userId, workspaceId },
          { agent_id: agentId, created: input.expectedSavedRevision === null },
        ),
      );
      return result(command);
    });
  }

  async function commandStatus(workspaceId: string, user: string | HumanActor, commandId: string) {
    workspaceId = uuidSchema.parse(workspaceId);
    user = typeof user === 'string' ? user : humanActorSchema.parse(user);
    commandId = uuidSchema.parse(commandId);
    return withHuman(runtime, workspaceId, user, 'read', async (transaction, actor) => {
      const command = commandSchema
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT * FROM ${relation(transaction, 'tf_agent_commands')} WHERE id = $1`,
              [commandId],
            )
          ).rows[0],
        );
      if (!command) throw new AccessDenied();
      if (command.membership_id === actor.membershipId) await authorize(transaction, actor, command);
      else await requireAgentPermission(transaction, actor, command.agent_id, 'edit');
      return result(command);
    });
  }

  async function prepare(writer: PrepareAgentRevision, workspaceId: string, commandId: string) {
    workspaceId = uuidSchema.parse(workspaceId);
    commandId = uuidSchema.parse(commandId);
    const loaded = await runtime.transaction(workspaceId, savedAgentCompatibility, async transaction => {
      await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agent_commands')} SET attempts = attempts + 1, status = CASE WHEN attempts >= 5 THEN 'failed' ELSE status END WHERE id = $1 AND status = 'preparing'`,
        [commandId],
      );
      const command = commandSchema.parse(
        (
          await transaction.client.query(`SELECT * FROM ${relation(transaction, 'tf_agent_commands')} WHERE id = $1`, [
            commandId,
          ])
        ).rows[0],
      );
      const parent = z
        .object({ bundle_key: z.string(), bundle_sha256: z.string() })
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT bundle_key, bundle_sha256 FROM ${relation(transaction, 'tf_soul_revisions')} WHERE revision = $1`,
              [command.input.expectedSoulRevision],
            )
          ).rows[0],
        );
      return { command, parent };
    });
    const { command } = loaded;
    if (command.status !== 'preparing') return result(command);
    async function failRevoked() {
      return runtime.transaction(workspaceId, savedAgentCompatibility, async transaction => {
        await transaction.client.query(
          `UPDATE ${relation(transaction, 'tf_agent_commands')} SET status = 'failed' WHERE id = $1 AND status = 'preparing'`,
          [commandId],
        );
        return result(
          commandSchema.parse(
            (
              await transaction.client.query(
                `SELECT * FROM ${relation(transaction, 'tf_agent_commands')} WHERE id=$1`,
                [commandId],
              )
            ).rows[0],
          ),
        );
      });
    }
    try {
      await withHuman(runtime, workspaceId, actorOf(command), 'read', async transaction => {
        await authorize(transaction, actorOf(command), command);
        if (await deletedSkillPins(transaction, command.input.definition.skills ?? [])) throw new AccessDenied();
        await requireCommandDraftSources(transaction, actorOf(command), command.id);
      });
    } catch (error) {
      if (error instanceof AccessDenied) return failRevoked();
      throw error;
    }
    const prepared = await writer({
      workspaceId,
      commandId,
      expectedParentCommit: command.input.expectedSoulRevision,
      createdAt: command.created_at.toISOString(),
      definition: { formatVersion: 1, id: command.agent_id, ...command.input.definition },
      parent: loaded.parent ? { key: loaded.parent.bundle_key, sha256: loaded.parent.bundle_sha256 } : null,
    });
    const projection = agentProjectionSchema.parse(prepared.projection);
    const expectedDigest = createHash('sha256')
      .update(serializeAgentDocument({ formatVersion: 1, id: command.agent_id, ...command.input.definition }))
      .digest('hex');
    if (projection.sha256 !== expectedDigest) throw new AgentError('prepared-definition-mismatch');
    soulRevisionSchema.parse(prepared.commit);
    if (
      prepared.parentCommit !== command.input.expectedSoulRevision ||
      projection.id !== command.agent_id ||
      projection.workspaceId !== workspaceId ||
      projection.commit !== prepared.commit
    )
      throw new AgentError('prepared-revision-mismatch');
    try {
      return await withHuman(runtime, workspaceId, actorOf(command), 'read', async (transaction, actor) => {
        await authorize(transaction, actor, command);
        if (await deletedSkillPins(transaction, command.input.definition.skills ?? [])) throw new AccessDenied();
        await requireCommandDraftSources(transaction, actor, command.id);
        const head = (
          await transaction.client.query(
            `SELECT revision FROM ${relation(transaction, 'tf_soul_head')} WHERE id = 1 FOR UPDATE`,
          )
        ).rows[0];
        const current = commandSchema.parse(
          (
            await transaction.client.query(
              `SELECT * FROM ${relation(transaction, 'tf_agent_commands')} WHERE id = $1 FOR UPDATE`,
              [commandId],
            )
          ).rows[0],
        );
        if (current.status !== 'preparing') return result(current);
        if (canonicalJson(current.input) !== canonicalJson(command.input)) throw new AgentError('command-changed');
        const item = (
          await transaction.client.query(
            `SELECT saved_revision, owning_team_id, deleted_at FROM ${relation(transaction, 'tf_agents')} WHERE id = $1`,
            [command.agent_id],
          )
        ).rows[0];
        if (
          head?.revision !== prepared.parentCommit ||
          (command.input.expectedSavedRevision === null
            ? Boolean(item)
            : !item ||
              item.saved_revision !== command.input.expectedSavedRevision ||
              item.owning_team_id !== command.input.owningTeamId ||
              item.deleted_at)
        ) {
          await transaction.client.query(
            `UPDATE ${relation(transaction, 'tf_agent_commands')} SET status = 'conflict' WHERE id = $1`,
            [commandId],
          );
          return { ...result(command), status: 'conflict' as const };
        }
        const familyId = command.input.definition.modelFamilyId;
        if (
          familyId !== undefined &&
          (await changesFamily(transaction, command.agent_id, familyId)) &&
          !(await modelFamilyEnabled(transaction, familyId))
        )
          throw new AccessDenied();
        const definition = canonicalJson(command.input.definition);
        const revision = createHash('sha256').update(definition).digest('hex');
        if (!item) {
          await transaction.client.query(
            `INSERT INTO ${relation(transaction, 'tf_agents')} (id, enabled, owning_team_id, display_name, creator_id) VALUES ($1,false,$2,$3,$4)`,
            [command.agent_id, command.input.owningTeamId, command.input.definition.name, actor.membershipId],
          );
          await transaction.client.query(
            `INSERT INTO ${relation(transaction, 'tf_agent_person_grants')} (agent_id,membership_id,permission) SELECT $1,$2,unnest(ARRAY['read','edit','delete','invoke','manage'])`,
            [command.agent_id, actor.membershipId],
          );
        }
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_definitions')} (agent_id, revision, definition) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [command.agent_id, revision, definition],
        );
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_soul_revisions')} (revision, parent_revision, agent_command_id, bundle_key, bundle_sha256) VALUES ($1,$2,$3,$4,$5)`,
          [prepared.commit, prepared.parentCommit, commandId, prepared.bundle.key, prepared.bundle.sha256],
        );
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_agent_saved_revisions')} (agent_id, soul_revision, definition_revision, projection) VALUES ($1,$2,$3,$4)`,
          [command.agent_id, prepared.commit, revision, projection],
        );
        await transaction.client.query(
          `UPDATE ${relation(transaction, 'tf_agents')} SET saved_revision = $2, display_name = $3 WHERE id = $1`,
          [command.agent_id, prepared.commit, command.input.definition.name],
        );
        await transaction.client.query(
          `UPDATE ${relation(transaction, 'tf_soul_head')} SET revision = $1, updated_at = now() WHERE id = 1`,
          [prepared.commit],
        );
        await transaction.client.query(
          `UPDATE ${relation(transaction, 'tf_agent_commands')} SET status = 'accepted', accepted_revision = $2 WHERE id = $1`,
          [commandId, prepared.commit],
        );
        await transaction.client.query(
          `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.definition.accepted',$3)`,
          [randomUUID(), actor.membershipId, command.agent_id],
        );
        return { ...result(command), status: 'accepted' as const, savedRevision: prepared.commit };
      });
    } catch (error) {
      if (error instanceof AccessDenied) return failRevoked();
      throw error;
    }
  }
  return {
    save,
    commandStatus,
    withWriter: (writer: PrepareAgentRevision) => ({
      prepare: (workspaceId: string, commandId: string) => prepare(writer, workspaceId, commandId),
    }),
  };
}
