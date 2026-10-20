import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  humanActorSchema,
  lockAuthorization,
  requireCurrentActor,
  resolveHuman,
  SourceAuthorizationUnavailable,
  sourceDependenciesSchema,
  uuidSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { agentCompatibility, relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { resolveSelectedSkills, skillIdSchema } from './skills.ts';
import {
  resolvedProceduresSchema,
  workspaceSkillSummarySchema,
  enableWorkspaceSkillSchema,
  procedureSelectionsSchema,
  reviewWorkspaceSkillSchema,
  saveWorkspaceSkillSchema,
  setWorkspaceSkillLifecycleSchema,
  skillPinUseSchema,
  workspaceSkillDefinitionSchema,
  workspaceSkillDeletionSchema,
  workspaceSkillLifecycleSchema,
  workspaceSkillQuerySchema,
  workspaceSkillReceiptSchema,
  WorkspaceSkillError,
} from './workspace-skill-contracts.ts';
import { agentDefinitionSchema } from './contracts.ts';
import { requireSavedSkillSources, savedSkillSources } from './skill-sources.ts';
import { requireDraftSources } from './draft-sources.ts';
import { requireNoMcpDerived } from '@tulipfarm/access';
import { personalDefinitionSources, requirePersonalDefinitionSources } from './personal-definition-sources.ts';
import { visiblePage } from './visible-page.ts';
import { canManageSkill, definitionGrantPredicate, requireSkillGrant, requireTeamManager } from '@tulipfarm/access';
import { skillSharingSchema } from './workspace-skill-contracts.ts';
import { requireAgentPermission } from './saved-policy.ts';
import { requireStoredSkillPackage, skillPackageCompatibility } from './skill-objects.ts';
import { skillDefinitionRevision } from './skill-packages.ts';
import { SkillPackageError } from './skill-package-contracts.ts';
import { definitionRecommendationAudience, recordDefinitionRecommendationChanges } from './recommendations.ts';

const storedDefinitionSchema = workspaceSkillDefinitionSchema.extend({ sources: sourceDependenciesSchema.optional() });
function publicDefinition(value: unknown) {
  const { sources: _sources, ...definition } = storedDefinitionSchema.parse(value);
  return definition;
}

export async function resolveProcedures(
  tx: AgentTransaction,
  selections: z.infer<typeof procedureSelectionsSchema> = [],
  actor?: HumanActor,
) {
  const procedures: z.infer<typeof resolvedProceduresSchema> = [];
  for (const selection of selections) {
    const builtin = skillIdSchema.safeParse(selection.id);
    if (builtin.success) {
      procedures.push(...resolveSelectedSkills([{ id: builtin.data, revision: selection.revision }]));
      continue;
    }
    // Activation pins revisions selected by an authorized author. Callers acting for a person check their use grant.
    if (actor) await requireSkillGrant(tx, actor, selection.id, 'use');
    const row = (
      await tx.client.query(
        `SELECT d.definition FROM ${relation(tx, 'tf_workspace_skills')} s JOIN ${relation(tx, 'tf_workspace_skill_reviews')} r ON r.skill_id=s.id JOIN ${relation(tx, 'tf_workspace_skill_revisions')} d ON d.skill_id=r.skill_id AND d.revision=r.revision WHERE s.id=$1 AND s.enabled AND r.revision=$2`,
        [selection.id, selection.revision],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    await requireSavedSkillSources(tx, selection.id, selection.revision, actor);
    procedures.push({ ...selection, ...storedDefinitionSchema.parse(row.definition) });
  }
  return procedures;
}

export async function resolveRunProcedures(tx: AgentTransaction, runId: string) {
  runId = uuidSchema.parse(runId);
  await requireCurrentActor(tx, { kind: 'agent', runId });
  const sponsor = `LEFT JOIN ${relation(tx, 'tf_agent_schedules')} s ON s.id=r.schedule_id`;
  const row = (
    await tx.client.query(
      `SELECT d.definition,d.agent_id,d.revision,m.id AS membership_id,m.user_id FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision ${sponsor} JOIN ${relation(tx, 'tf_memberships')} m ON m.id=${sponsor ? 'COALESCE(r.membership_id,s.sponsor_membership_id)' : 'r.membership_id'} AND m.removed_at IS NULL WHERE r.id=$1`,
      [runId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  await requirePersonalDefinitionSources(tx, [
    { kind: 'agent-definition', agentId: uuidSchema.parse(row.agent_id), revision: z.string().parse(row.revision) },
  ]);
  return resolveProcedures(tx, agentDefinitionSchema.parse(row.definition).skills, {
    kind: 'human',
    membershipId: uuidSchema.parse(row.membership_id),
    userId: z.string().parse(row.user_id),
  });
}

export async function resolveRunProcedure(tx: AgentTransaction, runId: string, id: string, revision: string) {
  const procedure = (await resolveRunProcedures(tx, runId)).find(item => item.id === id && item.revision === revision);
  if (!procedure) throw new AccessDenied();
  return procedure;
}

const rowSchema = workspaceSkillReceiptSchema
  .omit({ lifecycle: true })
  .extend({ creatorId: uuidSchema, lifecycle: workspaceSkillLifecycleSchema });
const columns =
  'id, creator_id AS "creatorId", version, saved_revision AS "savedRevision", active_revision AS "activeRevision", enabled';
const lifecycleColumn = `CASE WHEN s.deleted_at IS NOT NULL THEN 'deleted' WHEN s.archived_at IS NOT NULL THEN 'archived' ELSE 'active' END`;
type Row = z.infer<typeof rowSchema>;
type Receipt = z.infer<typeof workspaceSkillReceiptSchema>;
type Lifecycle = z.infer<typeof workspaceSkillLifecycleSchema>;
function receiptOf(row: unknown): Receipt {
  const { creatorId: _creatorId, lifecycle, ...receipt } = rowSchema.parse(row);
  return lifecycle === 'active' ? receipt : { ...receipt, lifecycle };
}

const policy: Record<'save' | 'review' | 'enable' | 'lifecycle', { states: readonly Lifecycle[] }> = {
  save: { states: ['active'] },
  review: { states: ['active'] },
  enable: { states: ['active', 'archived'] },
  lifecycle: { states: ['active', 'archived'] },
};

const pinsSchema = z.array(
  z.object({ agentId: uuidSchema, name: z.string().nullable(), uses: z.array(skillPinUseSchema).min(1) }),
);
async function pins(tx: AgentTransaction, skillId: string) {
  const agents = relation(tx, 'tf_agents'),
    definitions = relation(tx, 'tf_agent_definitions');
  return pinsSchema.parse(
    (
      await tx.client.query(
        `WITH pinned AS (
    SELECT a.id AS agent_id, 'saved-definition' AS use FROM ${agents} a JOIN ${relation(tx, 'tf_agent_saved_revisions')} s ON s.agent_id=a.id AND s.soul_revision=a.saved_revision JOIN ${definitions} d ON d.agent_id=s.agent_id AND d.revision=s.definition_revision WHERE d.definition->'skills' @> $1::jsonb
    UNION ALL SELECT v.agent_id, 'active-revision' FROM ${relation(tx, 'tf_agent_activations')} v JOIN ${definitions} d ON d.agent_id=v.agent_id AND d.revision=v.definition_revision WHERE v.revoked_at IS NULL AND d.definition->'skills' @> $1::jsonb
    UNION ALL SELECT r.agent_id, 'open-run' FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${definitions} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision WHERE r.status IN ('ready','running','waiting') AND d.definition->'skills' @> $1::jsonb
    UNION ALL SELECT t.agent_id, 'open-task' FROM ${relation(tx, 'tf_agent_tasks')} t WHERE t.status IN ('pending','waiting-clarification','waiting-approval','paused') AND t.skills @> $1::jsonb)
    SELECT p.agent_id AS "agentId", a.display_name AS name, array_agg(DISTINCT p.use ORDER BY p.use) AS uses FROM pinned p JOIN ${agents} a ON a.id=p.agent_id
    WHERE a.deleted_at IS NULL GROUP BY p.agent_id, a.display_name ORDER BY a.display_name, p.agent_id`,
        [JSON.stringify([{ id: skillId }])],
      )
    ).rows,
  );
}

export async function deletedSkillPins(tx: AgentTransaction, skills: readonly { id: string }[]) {
  const ids = skills.map(skill => skill.id).filter(id => uuidSchema.safeParse(id).success);
  if (!ids.length) return false;
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_workspace_skills')} WHERE id=ANY($1::uuid[]) AND deleted_at IS NOT NULL`,
        [ids],
      )
    ).rowCount,
  );
}

export function createWorkspaceSkills(storage: AgentStorage) {
  async function transaction<T>(
    workspaceId: string,
    user: string | HumanActor,
    write: boolean,
    operation: (tx: AgentTransaction & { commonVersion: number }, actor: HumanActor) => Promise<T>,
  ) {
    return storage.transaction(uuidSchema.parse(workspaceId), agentCompatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      const actor = typeof user === 'string' ? await resolveHuman(tx, user) : humanActorSchema.parse(user);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  async function load(tx: AgentTransaction, id: string) {
    return rowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT ${columns}, ${lifecycleColumn} AS lifecycle FROM ${relation(tx, 'tf_workspace_skills')} s WHERE s.id=$1`,
            [id],
          )
        ).rows[0],
      );
  }
  async function definition(tx: AgentTransaction, id: string, revision: string) {
    return publicDefinition(
      (
        await tx.client.query(
          `SELECT definition FROM ${relation(tx, 'tf_workspace_skill_revisions')} WHERE skill_id=$1 AND revision=$2`,
          [id, revision],
        )
      ).rows[0]?.definition,
    );
  }
  async function mutate(
    workspaceId: string,
    user: string | HumanActor,
    id: string,
    input: { requestId: string; expectedVersion: number },
    action: keyof typeof policy,
    apply: (tx: AgentTransaction, actor: HumanActor, current: Row | undefined) => Promise<void>,
  ) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, user, true, async (tx, actor) => {
      const current = await load(tx, id);
      if (action !== 'save' && !current) throw new AccessDenied();
      if (current) await requireSkillGrant(tx, actor, id, 'manage');
      const command = { action, id, ...input };
      const previous = (
        await tx.client.query(
          `SELECT input,receipt FROM ${relation(tx, 'tf_workspace_skill_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, input.requestId],
        )
      ).rows[0];
      const replay = previous && canonicalJson(previous.input) === canonicalJson(command);
      if (current?.lifecycle === 'deleted') {
        if (replay) return workspaceSkillReceiptSchema.parse(previous.receipt);
        throw new AccessDenied();
      }
      if (current) {
        await requireSavedSkillSources(tx, id, current.savedRevision, actor);
        if (current.activeRevision) await requireSavedSkillSources(tx, id, current.activeRevision, actor);
      }
      if (previous) {
        if (!replay) throw new WorkspaceSkillError('idempotency-conflict');
        return workspaceSkillReceiptSchema.parse(previous.receipt);
      }
      if (current && !policy[action].states.includes(current.lifecycle))
        throw new WorkspaceSkillError('skill-archived');
      if ((current?.version ?? 0) !== input.expectedVersion) throw new WorkspaceSkillError('version-conflict');
      const before = await definitionRecommendationAudience(tx, 'skill', id);
      await apply(tx, actor, current);
      await recordDefinitionRecommendationChanges(tx, 'skill', id, before);
      const receipt = receiptOf(await load(tx, id));
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_workspace_skill_commands')} (membership_id,request_id,input,receipt) VALUES ($1,$2,$3,$4)`,
        [actor.membershipId, input.requestId, command, receipt],
      );
      return receipt;
    });
  }
  async function save(
    workspaceId: string,
    user: string | HumanActor,
    id: string,
    value: unknown,
    origin: readonly SourceDependency[] = [],
    packageId?: string,
  ) {
    id = uuidSchema.parse(id);
    const input = saveWorkspaceSkillSchema.parse(value);
    const command = {
      ...input,
      ...(origin.length ? { sources: sourceDependenciesSchema.parse(origin) } : {}),
      ...(packageId ? { packageId: uuidSchema.parse(packageId) } : {}),
    };
    return mutate(workspaceId, user, id, command, 'save', async (tx, actor, current) => {
      const pkg = input.definition.package
        ? await requireStoredSkillPackage(tx, actor, input.definition.package, packageId)
        : null;
      if (
        pkg &&
        (input.definition.package?.manifest.metadata.name !== input.definition.name ||
          pkg.instructions !== input.definition.instructions)
      )
        throw new SkillPackageError('package-mismatch');
      const sources = sourceDependenciesSchema.parse([
        ...new Map(
          [
            ...origin,
            ...(pkg?.sources ?? []),
            ...(current ? await savedSkillSources(tx, id, current.savedRevision) : []),
          ].map(source => [canonicalJson(source), source]),
        ).values(),
      ]);
      await requireNoMcpDerived(tx, sources);
      await requireDraftSources(tx, actor, sources);
      const stored = (await personalDefinitionSources(tx, sources)).length
        ? { ...input.definition, sources }
        : input.definition;
      const revision = skillDefinitionRevision(stored);
      if (!current) {
        const count = z
          .number()
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_workspace_skills')} WHERE deleted_at IS NULL`,
              )
            ).rows[0]?.count,
          );
        if (count >= 1000) throw new WorkspaceSkillError('limit-reached');
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_workspace_skills')} (id,creator_id,saved_revision) VALUES ($1,$2,$3)`,
          [id, actor.membershipId, revision],
        );
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_skill_person_grants')} (skill_id,membership_id,permission) SELECT $1,$2,unnest(ARRAY['read','use','manage'])`,
          [id, actor.membershipId],
        );
      } else {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_workspace_skills')} SET saved_revision=$2,version=version+1 WHERE id=$1`,
          [id, revision],
        );
      }
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_workspace_skill_revisions')} (skill_id,revision,definition,author_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [id, revision, stored, actor.membershipId],
      );
      if (pkg)
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_skill_revision_packages')} (skill_id,revision,package_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [id, revision, pkg.id],
        );
    });
  }
  async function review(workspaceId: string, user: string | HumanActor, id: string, value: unknown) {
    id = uuidSchema.parse(id);
    const input = reviewWorkspaceSkillSchema.parse(value);
    return mutate(workspaceId, user, id, input, 'review', async (tx, actor, current) => {
      if (!current || current.savedRevision !== input.revision) throw new WorkspaceSkillError('version-conflict');
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_workspace_skill_reviews')} (skill_id,revision,reviewer_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [id, input.revision, actor.membershipId],
      );
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_workspace_skills')} SET active_revision=$2,enabled=true,version=version+1 WHERE id=$1`,
        [id, input.revision],
      );
    });
  }
  async function setEnabled(workspaceId: string, user: string | HumanActor, id: string, value: unknown) {
    id = uuidSchema.parse(id);
    const input = enableWorkspaceSkillSchema.parse(value);
    return mutate(workspaceId, user, id, input, 'enable', async (tx, _actor, current) => {
      if (!current?.activeRevision) throw new WorkspaceSkillError('review-required');
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_workspace_skills')} SET enabled=$2,version=version+1 WHERE id=$1`,
        [id, input.enabled],
      );
      if (!input.enabled) {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_runs')} r SET status='blocked' FROM ${relation(tx, 'tf_agent_definitions')} d WHERE d.agent_id=r.agent_id AND d.revision=r.definition_revision AND r.status IN ('ready','running','waiting') AND d.definition->'skills' @> $1::jsonb`,
          [JSON.stringify([{ id }])],
        );
      }
    });
  }
  async function setLifecycle(workspaceId: string, user: string | HumanActor, id: string, value: unknown) {
    id = uuidSchema.parse(id);
    const input = setWorkspaceSkillLifecycleSchema.parse(value);
    return mutate(workspaceId, user, id, input, 'lifecycle', async (tx, _actor, current) => {
      if (current?.lifecycle === input.lifecycle) return;
      if (input.lifecycle === 'deleted' && (await pins(tx, id)).length) throw new WorkspaceSkillError('skill-in-use');
      const assignment = {
        active: 'archived_at=NULL',
        archived: 'archived_at=clock_timestamp()',
        deleted: 'deleted_at=clock_timestamp(),enabled=false',
      }[input.lifecycle];
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_workspace_skills')} SET ${assignment},version=version+1 WHERE id=$1`,
        [id],
      );
    });
  }
  async function deletion(workspaceId: string, user: string | HumanActor, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const row = await load(tx, id);
      if (!row || row.lifecycle === 'deleted') throw new AccessDenied();
      await requireSkillGrant(tx, actor, id, 'manage');
      await requireSavedSkillSources(tx, id, row.savedRevision, actor);
      const agents = await pins(tx, id);
      const blockers: typeof agents = [];
      let hiddenAgents = 0;
      for (const agent of agents) {
        try {
          await requireAgentPermission(tx, actor, agent.agentId, 'read');
        } catch (error) {
          if (!(error instanceof AccessDenied) || error instanceof SourceAuthorizationUnavailable) throw error;
          hiddenAgents++;
          continue;
        }
        if (blockers.length < 20) blockers.push(agent);
      }
      return workspaceSkillDeletionSchema.parse({
        id,
        name: (await definition(tx, id, row.savedRevision)).name,
        version: row.version,
        lifecycle: row.lifecycle,
        blockers,
        hiddenAgents,
        blockerCount: agents.length,
      });
    });
  }
  async function read(workspaceId: string, user: string | HumanActor, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const row = await load(tx, id);
      if (!row || row.lifecycle === 'deleted') throw new AccessDenied();
      await requireSkillGrant(tx, actor, id, 'read');
      const editor = await canManageSkill(tx, actor, id);
      const revision = editor ? row.savedRevision : row.enabled ? row.activeRevision : null;
      if (!revision) throw new AccessDenied();
      await requireSavedSkillSources(tx, id, revision, actor);
      if (editor && row.activeRevision) await requireSavedSkillSources(tx, id, row.activeRevision, actor);
      return {
        id: row.id,
        revision,
        definition: await definition(tx, id, revision),
        reviewedDefinition: editor && row.activeRevision ? await definition(tx, id, row.activeRevision) : null,
        source: 'workspace' as const,
        management: editor ? receiptOf(row) : null,
        canReview: editor,
        lifecycle: row.lifecycle,
        canManageLifecycle: editor,
      };
    });
  }
  async function list(workspaceId: string, user: string | HumanActor, value: unknown = {}) {
    const query = workspaceSkillQuerySchema.parse(value);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const manages = definitionGrantPredicate(tx, 'skill', 's.id', '$1', "'manage'");
      const reads = definitionGrantPredicate(tx, 'skill', 's.id', '$1', query.view === 'reviewed' ? "'use'" : "'read'");
      const source =
        tx.commonVersion >= skillPackageCompatibility.minimum
          ? `COALESCE((SELECT CASE WHEN p.provenance->'source'->>'submittedUrl'='chat' THEN 'Created in chat' ELSE p.provenance->'source'->>'canonicalUrl' END FROM ${relation(tx, 'tf_skill_package_provenance')} p WHERE p.skill_id=s.id AND p.revision=r.revision),'Legacy skill')`
          : "'Legacy skill'";
      const page = await visiblePage(
        query,
        async (after, limit) =>
          z.array(workspaceSkillSummarySchema).parse(
            (
              await tx.client.query(
                `SELECT s.id,r.revision,r.definition->>'name' AS name,
        left(COALESCE(r.definition#>>'{package,manifest,metadata,description}',r.definition->>'description','Workspace procedure.'),1024) AS description, ${source} AS source,
        CASE WHEN s.archived_at IS NOT NULL THEN 'archived' WHEN r.revision IS DISTINCT FROM s.active_revision THEN 'needs-review' WHEN NOT s.enabled THEN 'disabled' ELSE 'enabled' END AS status FROM ${relation(tx, 'tf_workspace_skills')} s JOIN ${relation(tx, 'tf_workspace_skill_revisions')} r ON r.skill_id=s.id AND r.revision=CASE WHEN NOT $4 AND ${manages} THEN s.saved_revision ELSE s.active_revision END WHERE ${reads} AND ${lifecycleColumn}=$6::text AND (s.enabled OR (NOT $4 AND ${manages})) AND ($2::uuid IS NULL OR s.id>$2) AND strpos(lower(r.definition->>'name'),lower($5))>0 ORDER BY s.id LIMIT $3`,
                [
                  actor.membershipId,
                  after ?? null,
                  limit,
                  query.view === 'reviewed',
                  query.search,
                  query.view === 'archived' ? 'archived' : 'active',
                ],
              )
            ).rows,
          ),
        row => requireSavedSkillSources(tx, row.id, row.revision, actor),
      );
      return { workspace: page.items, nextCursor: page.nextCursor };
    });
  }
  async function resolve(workspaceId: string, user: string | HumanActor, value: unknown) {
    const selections = procedureSelectionsSchema.parse(value);
    return transaction(workspaceId, user, false, (tx, actor) => resolveProcedures(tx, selections, actor));
  }
  async function resolveRun(workspaceId: string, runId: string) {
    return storage.transaction(uuidSchema.parse(workspaceId), agentCompatibility, async tx => {
      await lockAuthorization(tx);
      return resolveRunProcedures(tx, runId);
    });
  }
  async function sharing(workspaceId: string, user: string, id: string) {
    return transaction(workspaceId, user, false, async (tx, actor) => {
      await requireSkillGrant(tx, actor, id, 'manage');
      const row = await load(tx, id);
      if (!row || row.lifecycle === 'deleted') throw new AccessDenied();
      await requireSavedSkillSources(tx, id, row.savedRevision, actor);
      const personGrants = (
        await tx.client.query(
          `SELECT membership_id AS "membershipId",array_agg(permission ORDER BY permission) AS permissions FROM ${relation(tx, 'tf_skill_person_grants')} WHERE skill_id=$1 GROUP BY membership_id`,
          [id],
        )
      ).rows;
      const grants = (
        await tx.client.query(
          `SELECT team_id AS "teamId",array_agg(permission ORDER BY permission) AS permissions FROM ${relation(tx, 'tf_skill_team_grants')} WHERE skill_id=$1 GROUP BY team_id`,
          [id],
        )
      ).rows;
      return skillSharingSchema.parse({ version: row.version, grants, personGrants });
    });
  }
  async function share(workspaceId: string, user: string, id: string, value: unknown) {
    const input = skillSharingSchema.parse(value);
    return transaction(workspaceId, user, true, async (tx, actor) => {
      await requireSkillGrant(tx, actor, id, 'manage');
      const row = await load(tx, id);
      if (!row || row.lifecycle === 'deleted') throw new AccessDenied();
      await requireSavedSkillSources(tx, id, row.savedRevision, actor);
      if (row.activeRevision) await requireSavedSkillSources(tx, id, row.activeRevision, actor);
      if (row.version !== input.version) throw new WorkspaceSkillError('version-conflict');
      const before = await definitionRecommendationAudience(tx, 'skill', id);
      if (![...input.grants, ...input.personGrants].some(grant => grant.permissions.includes('manage')))
        throw new AccessDenied();
      for (const grant of input.grants) {
        const previous = z
          .array(z.object({ permission: z.string() }))
          .parse(
            (
              await tx.client.query(
                `SELECT permission FROM ${relation(tx, 'tf_skill_team_grants')} WHERE skill_id=$1 AND team_id=$2`,
                [id, grant.teamId],
              )
            ).rows,
          );
        if (grant.permissions.some(permission => !previous.some(row => row.permission === permission)))
          await requireTeamManager(tx, actor, grant.teamId);
      }
      for (const grant of input.personGrants)
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
              [grant.membershipId],
            )
          ).rowCount
        )
          throw new AccessDenied();
      if (!input.personGrants.some(grant => grant.permissions.includes('manage'))) {
        const managers = input.grants.filter(grant => grant.permissions.includes('manage')).map(grant => grant.teamId);
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_member_teams')} mt JOIN ${relation(tx, 'tf_memberships')} m ON m.id=mt.membership_id AND m.removed_at IS NULL WHERE mt.team_id=ANY($1::uuid[]) LIMIT 1`,
              [managers],
            )
          ).rowCount
        )
          throw new AccessDenied();
      }
      for (const grant of [...input.grants, ...input.personGrants])
        if (
          grant.permissions.includes('use') &&
          !grant.permissions.includes('read') &&
          !grant.permissions.includes('manage')
        )
          throw new AccessDenied();
      await tx.client.query(`DELETE FROM ${relation(tx, 'tf_skill_person_grants')} WHERE skill_id=$1`, [id]);
      await tx.client.query(`DELETE FROM ${relation(tx, 'tf_skill_team_grants')} WHERE skill_id=$1`, [id]);
      for (const grant of input.personGrants)
        for (const permission of new Set(grant.permissions))
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_skill_person_grants')} (skill_id,membership_id,permission) VALUES ($1,$2,$3)`,
            [id, grant.membershipId, permission],
          );
      for (const grant of input.grants)
        for (const permission of new Set(grant.permissions))
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_skill_team_grants')} (skill_id,team_id,permission) VALUES ($1,$2,$3)`,
            [id, grant.teamId, permission],
          );
      await tx.client.query(`UPDATE ${relation(tx, 'tf_workspace_skills')} SET version=version+1 WHERE id=$1`, [id]);
      await recordDefinitionRecommendationChanges(tx, 'skill', id, before);
      return { saved: true };
    });
  }
  return { save, review, setEnabled, setLifecycle, deletion, read, list, resolve, resolveRun, sharing, share };
}
