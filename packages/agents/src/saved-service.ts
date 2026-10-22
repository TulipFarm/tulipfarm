import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  AccessDenied,
  definitionGrantPredicate,
  requireTeamManager,
  requireTeamMember,
  uuidSchema,
  type HumanActor,
} from '@tulipfarm/access';
import {
  agentDefinitionSchema,
  executionPolicySchema,
  maximumTaskLimits,
  scopeSchema,
  taskLimitsSchema,
} from './contracts.ts';
import { AgentError, agentPolicySchema, agentProjectionSchema, savedAgentSchema } from './saved-contracts.ts';
import { requireAgentPermission, withHuman } from './saved-policy.ts';
export { requireAgentPermission } from './saved-policy.ts';
import { createAgentStore, relation, type AgentStorage } from './store.ts';
import { visiblePage } from './visible-page.ts';
import { definitionRecommendationAudience, recordDefinitionRecommendationChanges } from './recommendations.ts';
import { listSkills } from './skills.ts';

type ProjectionReader = (workspaceId: string, projection: z.infer<typeof agentProjectionSchema>) => Promise<unknown>;
const selectedSchema = savedAgentSchema.extend({ projection: agentProjectionSchema });

export function createSavedAgentService(runtime: AgentStorage, readProjection?: ProjectionReader) {
  const executor = createAgentStore(runtime);
  async function list(
    workspaceId: string,
    user: string | HumanActor,
    query: { after?: string | undefined; limit?: number | undefined; search?: string | undefined } = {},
  ) {
    const input = z
      .object({
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        search: z.string().trim().max(120).default(''),
      })
      .parse(query);
    return withHuman(runtime, workspaceId, user, 'read', async (transaction, actor) => {
      const predicate = `a.saved_revision IS NOT NULL AND a.deleted_at IS NULL AND ${definitionGrantPredicate(transaction, 'agent', 'a.id', '$2', '$1')}`;
      const page = await visiblePage(
        input,
        async (after, limit) => {
          const rows = await transaction.client.query(
            `SELECT a.id, a.display_name AS name, a.owning_team_id AS "owningTeamId", a.saved_revision AS "savedRevision", s.definition_revision AS "definitionRevision" FROM ${relation(transaction, 'tf_agents')} a JOIN ${relation(transaction, 'tf_agent_saved_revisions')} s ON s.agent_id = a.id AND s.soul_revision = a.saved_revision WHERE ${predicate} AND ($3::uuid IS NULL OR a.id > $3) AND strpos(lower(a.display_name),lower($5))>0 ORDER BY a.id LIMIT $4`,
            ['read', actor.membershipId, after ?? null, limit, input.search],
          );
          return z.array(savedAgentSchema).parse(rows.rows);
        },
        item => requireAgentPermission(transaction, actor, item.id, 'read'),
      );
      return {
        agents: page.items,
        ...(!input.after && !page.nextCursor ? { count: page.items.length } : {}),
        nextCursor: page.nextCursor,
      };
    });
  }

  async function recent(workspaceId: string, user: string) {
    return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
      const agents = relation(tx, 'tf_agents'),
        revisions = relation(tx, 'tf_soul_revisions');
      const page = await visiblePage(
        { limit: 3 },
        async (after, limit) =>
          z.array(z.object({ id: uuidSchema, name: z.string() })).parse(
            (
              await tx.client.query(
                `SELECT a.id,a.display_name AS name FROM ${agents} a JOIN ${revisions} r ON r.revision=a.saved_revision
         WHERE a.deleted_at IS NULL AND ${definitionGrantPredicate(tx, 'agent', 'a.id', '$2', '$1')}
           AND ($3::uuid IS NULL OR (r.accepted_at,a.id)<(SELECT r.accepted_at,a.id FROM ${agents} a JOIN ${revisions} r ON r.revision=a.saved_revision WHERE a.id=$3))
         ORDER BY r.accepted_at DESC,a.id DESC LIMIT $4`,
                ['read', actor.membershipId, after ?? null, limit],
              )
            ).rows,
          ),
        item => requireAgentPermission(tx, actor, item.id, 'read'),
      );
      return page.items;
    });
  }

  async function detail(workspaceId: string, user: string, agentIdInput: string) {
    if (!readProjection) throw new AgentError('projection-reader-unavailable', 503);
    const agentId = uuidSchema.parse(agentIdInput);
    const selected = await withHuman(runtime, workspaceId, user, 'read', async (transaction, actor) => {
      await requireAgentPermission(transaction, actor, agentId, 'read');
      const item = selectedSchema.parse(
        (
          await transaction.client.query(
            `SELECT a.id, a.display_name AS name, a.owning_team_id AS "owningTeamId", a.saved_revision AS "savedRevision", s.definition_revision AS "definitionRevision", s.projection FROM ${relation(transaction, 'tf_agents')} a JOIN ${relation(transaction, 'tf_agent_saved_revisions')} s ON s.agent_id = a.id AND s.soul_revision = a.saved_revision WHERE a.id = $1`,
            [agentId],
          )
        ).rows[0],
      );
      return { item, actor };
    });
    const document = z
      .object({ formatVersion: z.literal(1), id: uuidSchema, ...agentDefinitionSchema.shape })
      .parse(await readProjection(workspaceId, selected.item.projection));
    if (document.id !== agentId) throw new AgentError('projection-identity-mismatch', 503);
    return withHuman(runtime, workspaceId, selected.actor, 'read', async (transaction, actor) => {
      await requireAgentPermission(transaction, actor, agentId, 'read');
      const current = (
        await transaction.client.query(
          `SELECT saved_revision FROM ${relation(transaction, 'tf_agents')} WHERE id = $1`,
          [agentId],
        )
      ).rows[0];
      if (current?.saved_revision !== selected.item.savedRevision) throw new AgentError('definition-changed');
      const capabilities: string[] = [];
      for (const permission of ['edit', 'delete', 'invoke', 'manage'] as const) {
        try {
          await requireAgentPermission(transaction, actor, agentId, permission);
          capabilities.push(permission);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
        }
      }
      const activations = z
        .array(z.object({ id: z.uuid(), revision: z.string(), scope: scopeSchema }))
        .parse(
          (
            await transaction.client.query(
              `SELECT id, definition_revision AS revision, scope FROM ${relation(transaction, 'tf_agent_activations')} WHERE agent_id = $1 AND revoked_at IS NULL ORDER BY id`,
              [agentId],
            )
          ).rows,
        );
      const { formatVersion: _formatVersion, id: _id, ...definition } = document;
      return {
        ...savedAgentSchema.parse(selected.item),
        definition: agentDefinitionSchema.parse(definition),
        capabilities,
        activations,
      };
    });
  }

  async function context(workspaceId: string, user: string | HumanActor) {
    return withHuman(runtime, workspaceId, user, 'read', async (transaction, actor) => {
      const teams = z
        .array(z.object({ id: z.uuid(), name: z.string() }))
        .parse(
          (
            await transaction.client.query(
              `SELECT t.id, t.name FROM ${relation(transaction, 'tf_teams')} t JOIN ${relation(transaction, 'tf_member_teams')} mt ON mt.team_id=t.id WHERE mt.membership_id=$1 ORDER BY t.name,t.id`,
              [actor.membershipId],
            )
          ).rows,
        );
      const currentSoulRevision = z
        .string()
        .parse(
          (await transaction.client.query(`SELECT revision FROM ${relation(transaction, 'tf_soul_head')} WHERE id = 1`))
            .rows[0]?.revision,
        );
      return { currentSoulRevision, teams, builtinSkills: listSkills().skills };
    });
  }

  async function sharingCandidates(workspaceId: string, user: string) {
    return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
      const people = z
        .array(z.object({ membershipId: z.uuid(), userId: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT id AS "membershipId",user_id AS "userId" FROM ${relation(tx, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY id`,
            )
          ).rows,
        );
      const teams = z
        .array(z.object({ id: z.uuid(), name: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT t.id,t.name FROM ${relation(tx, 'tf_teams')} t JOIN ${relation(tx, 'tf_member_teams')} m ON m.team_id=t.id WHERE m.membership_id=$1 AND m.role='manager' ORDER BY t.name,t.id`,
              [actor.membershipId],
            )
          ).rows,
        );
      return { membershipId: actor.membershipId, people, teams };
    });
  }

  async function policy(workspaceId: string, user: string, agentId: string) {
    return withHuman(runtime, workspaceId, user, 'read', async (transaction, actor) => {
      await requireAgentPermission(transaction, actor, agentId, 'manage');
      const owningTeamId = z
        .uuid()
        .nullable()
        .parse(
          (
            await transaction.client.query(
              `SELECT owning_team_id FROM ${relation(transaction, 'tf_agents')} WHERE id = $1`,
              [agentId],
            )
          ).rows[0]?.owning_team_id,
        );
      const version = z
        .number()
        .parse(
          (
            await transaction.client.query(
              `SELECT policy_version FROM ${relation(transaction, 'tf_agents')} WHERE id = $1`,
              [agentId],
            )
          ).rows[0]?.policy_version,
        );
      const grants = z
        .array(agentPolicySchema.shape.grants.element)
        .parse(
          (
            await transaction.client.query(
              `SELECT team_id AS "teamId", array_agg(permission ORDER BY permission) AS permissions FROM ${relation(transaction, 'tf_agent_grants')} WHERE agent_id = $1 GROUP BY team_id ORDER BY team_id`,
              [agentId],
            )
          ).rows,
        );
      const enrollment = z
        .array(z.object({ team_id: z.uuid() }))
        .parse(
          (
            await transaction.client.query(
              `SELECT team_id FROM ${relation(transaction, 'tf_agent_teams')} WHERE agent_id = $1 ORDER BY team_id`,
              [agentId],
            )
          ).rows,
        )
        .map(row => row.team_id);
      const personGrants = z
        .array(agentPolicySchema.shape.personGrants.element)
        .parse(
          (
            await transaction.client.query(
              `SELECT membership_id AS "membershipId",array_agg(permission ORDER BY permission) AS permissions FROM ${relation(transaction, 'tf_agent_person_grants')} WHERE agent_id=$1 GROUP BY membership_id ORDER BY membership_id`,
              [agentId],
            )
          ).rows,
        );
      const enabled = z
        .boolean()
        .parse(
          (
            await transaction.client.query(`SELECT enabled FROM ${relation(transaction, 'tf_agents')} WHERE id=$1`, [
              agentId,
            ])
          ).rows[0]?.enabled,
        );
      const configured = (
        await transaction.client.query(
          `SELECT scope,task_limits FROM ${relation(transaction, 'tf_agent_limits')} WHERE agent_id=$1`,
          [agentId],
        )
      ).rows[0];
      const limits = scopeSchema.parse(configured?.scope ?? []);
      const taskLimits = taskLimitsSchema.parse(configured?.task_limits ?? maximumTaskLimits);
      const slackSender =
        transaction.commonVersion >= 1
          ? z
              .enum(['user', 'app'])
              .parse(
                (
                  await transaction.client.query(
                    `SELECT slack_sender FROM ${relation(transaction, 'tf_agents')} WHERE id=$1`,
                    [agentId],
                  )
                ).rows[0]?.slack_sender,
              )
          : ('user' as const);
      return { version, owningTeamId, grants, personGrants, enrollment, enabled, limits, taskLimits, slackSender };
    });
  }

  async function updatePolicy(workspaceId: string, user: string, agentId: string, value: unknown) {
    const input = agentPolicySchema.parse(value);
    if (
      [...input.grants, ...input.personGrants].some(
        grant =>
          !grant.permissions.includes('manage') &&
          grant.permissions.some(p => p !== 'read') &&
          !grant.permissions.includes('read'),
      )
    )
      throw new AgentError('read-grant-required', 400);
    return withHuman(runtime, workspaceId, user, 'write', async (transaction, actor) => {
      await requireAgentPermission(transaction, actor, agentId, 'manage');
      const before = await definitionRecommendationAudience(transaction, 'agent', agentId);
      const placed = z
        .uuid()
        .nullable()
        .parse(
          (
            await transaction.client.query(
              `SELECT owning_team_id FROM ${relation(transaction, 'tf_agents')} WHERE id=$1`,
              [agentId],
            )
          ).rows[0]?.owning_team_id,
        );
      if (input.owningTeamId && input.owningTeamId !== placed)
        await requireTeamMember(transaction, actor, input.owningTeamId);
      for (const grant of input.grants) {
        const previous = z
          .array(z.object({ permission: z.string() }))
          .parse(
            (
              await transaction.client.query(
                `SELECT permission FROM ${relation(transaction, 'tf_agent_grants')} WHERE agent_id=$1 AND team_id=$2`,
                [agentId, grant.teamId],
              )
            ).rows,
          );
        if (grant.permissions.some(permission => !previous.some(row => row.permission === permission)))
          await requireTeamManager(transaction, actor, grant.teamId);
      }
      for (const grant of input.personGrants)
        if (
          !(
            await transaction.client.query(
              `SELECT 1 FROM ${relation(transaction, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
              [grant.membershipId],
            )
          ).rowCount
        )
          throw new AccessDenied();
      if (![...input.grants, ...input.personGrants].some(grant => grant.permissions.includes('manage')))
        throw new AgentError('manager-required', 400);
      if (!input.personGrants.some(grant => grant.permissions.includes('manage'))) {
        const managers = input.grants.filter(grant => grant.permissions.includes('manage')).map(grant => grant.teamId);
        if (
          !(
            await transaction.client.query(
              `SELECT 1 FROM ${relation(transaction, 'tf_member_teams')} mt JOIN ${relation(transaction, 'tf_memberships')} m ON m.id=mt.membership_id AND m.removed_at IS NULL WHERE mt.team_id=ANY($1::uuid[]) LIMIT 1`,
              [managers],
            )
          ).rowCount
        )
          throw new AgentError('manager-required', 400);
      }
      const changed = await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agents')} SET owning_team_id = $2, policy_version = policy_version + 1 WHERE id = $1 AND policy_version = $3`,
        [agentId, input.owningTeamId, input.version],
      );
      if (!changed.rowCount) throw new AgentError('policy-version-conflict');
      await transaction.client.query(`DELETE FROM ${relation(transaction, 'tf_agent_grants')} WHERE agent_id = $1`, [
        agentId,
      ]);
      for (const grant of input.grants)
        for (const permission of new Set(grant.permissions))
          await transaction.client.query(
            `INSERT INTO ${relation(transaction, 'tf_agent_grants')} (agent_id, team_id, permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [agentId, grant.teamId, permission],
          );
      await transaction.client.query(
        `DELETE FROM ${relation(transaction, 'tf_agent_person_grants')} WHERE agent_id=$1`,
        [agentId],
      );
      for (const grant of input.personGrants)
        for (const permission of new Set(grant.permissions))
          await transaction.client.query(
            `INSERT INTO ${relation(transaction, 'tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [agentId, grant.membershipId, permission],
          );
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.policy.update',$3)`,
        [randomUUID(), actor.membershipId, agentId],
      );
      await recordDefinitionRecommendationChanges(transaction, 'agent', agentId, before);
      return { saved: true };
    });
  }

  async function remove(workspaceId: string, user: string, agentId: string) {
    return withHuman(runtime, workspaceId, user, 'write', async (transaction, actor) => {
      await requireAgentPermission(transaction, actor, agentId, 'delete');
      const before = await definitionRecommendationAudience(transaction, 'agent', agentId);
      await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agents')} SET deleted_at = now(), enabled = false, owning_team_id = NULL WHERE id = $1`,
        [agentId],
      );
      await transaction.client.query(
        `UPDATE ${relation(transaction, 'tf_agent_activations')} SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL`,
        [agentId],
      );
      await transaction.client.query(
        `INSERT INTO ${relation(transaction, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,'agent.delete',$3)`,
        [randomUUID(), actor.membershipId, agentId],
      );
      await recordDefinitionRecommendationChanges(transaction, 'agent', agentId, before);
      return { deleted: true };
    });
  }

  async function administer<T>(
    workspaceId: string,
    user: string,
    agentId: string,
    operation: (actor: HumanActor) => Promise<T>,
  ) {
    const actor = await withHuman(runtime, workspaceId, user, 'read', async (transaction, actor) => {
      await requireAgentPermission(transaction, actor, agentId, 'manage');
      return actor;
    });
    return operation(actor);
  }
  return {
    list,
    recent,
    detail,
    context,
    sharingCandidates,
    policy,
    updatePolicy,
    remove,
    revokeActivation: (workspaceId: string, user: string, agentId: string, activationId: string) =>
      administer(workspaceId, user, agentId, actor =>
        executor.revokeActivation(workspaceId, actor, { agentId, activationId }),
      ),
    activate: (workspaceId: string, user: string, agentId: string, value: unknown) => {
      const input = z
        .strictObject({ revision: z.string(), scope: scopeSchema, requestId: uuidSchema.optional() })
        .parse(value);
      return administer(workspaceId, user, agentId, actor =>
        executor.activate(workspaceId, actor, { agentId, ...input }),
      );
    },
    configure: (workspaceId: string, user: string, agentId: string, value: unknown) => {
      const input = executionPolicySchema.parse(value);
      return administer(workspaceId, user, agentId, actor =>
        executor.configure(workspaceId, actor, { agentId, ...input }).then(() => ({ saved: true })),
      );
    },
  };
}
