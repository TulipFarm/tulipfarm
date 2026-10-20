import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { denyMcpEgress, requireNoMcpDerived } from '@tulipfarm/access';
import {
  AccessDenied,
  canAccessAsset,
  lockAuthorization,
  requireTeamManager,
  requirePersistedIssueCall,
  resolveActor,
  type Actor,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { actorSchema, uuidSchema } from '@tulipfarm/access/contracts';
import {
  IntegrationError,
  updateCreationGrantsSchema,
  integrationGrantsSchema,
  createIntegrationSchema,
  issueResultSchema,
  readIssueSchema,
  repositorySchema,
  rotateIntegrationSchema,
  transferIntegrationSchema,
  updateIntegrationSchema,
  type IntegrationDetail,
  type IntegrationMetadata,
  type ReadIssue,
} from './contracts.ts';
import { credentialCipher, type IntegrationKeyring } from './credentials.ts';
import { fetchIssue } from './github.ts';
import { validateIntegrationRecipients } from './authorization.ts';
import { watchIntegrationRecommendations } from './recommendations.ts';
import { integrationCreationRecommendations, integrationRecommendations } from './recommendation-state.ts';
import { investigationGrants, replaceInvestigationGrants } from './investigation-grants.ts';

export { integrationCredentialKeyring, type IntegrationKeyring } from './credentials.ts';
export { IntegrationError } from './contracts.ts';
export type IntegrationStorage = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export const integrationCompatibility = commonCompatibility;
type Options = { runtime: IntegrationStorage; keyring?: IntegrationKeyring; providerFetch?: typeof fetch };
const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const metadataRow = z.object({
  id: uuidSchema,
  owning_team_id: uuidSchema,
  name: z.string(),
  enabled: z.boolean(),
  generation: z.number().int(),
  grants_version: z.number().int(),
});
const dispatchSchema = z.object({
  actor: actorSchema,
  integration_id: uuidSchema,
  source_id: uuidSchema,
  issue_number: z.number().int(),
  generation: z.number().int(),
  attempt: z.number().int(),
  status: z.enum(['executing', 'failed', 'completed']),
  result: issueResultSchema.nullable(),
  stale: z.boolean(),
});

export function createIntegrationService(options: Options) {
  const cipher = credentialCipher(options.keyring);
  async function authorized<T>(
    workspaceId: string,
    principal: string | Actor,
    mode: 'read' | 'write',
    operation: (tx: AuthorizationTransaction, actor: Actor) => Promise<T>,
    minimum: number = integrationCompatibility.minimum,
  ) {
    return options.runtime.transaction(
      uuidSchema.parse(workspaceId),
      { ...integrationCompatibility, minimum },
      async tx => {
        await lockAuthorization(tx, mode);
        return operation(tx, await resolveActor(tx, principal));
      },
    );
  }
  async function teamManager(tx: AuthorizationTransaction, actor: Actor, id: string) {
    if (actor.kind !== 'human') throw new AccessDenied();
    await requireTeamManager(tx, actor, id);
  }
  async function permission(tx: AuthorizationTransaction, actor: Actor, id: string, action: 'read' | 'use' | 'manage') {
    if (!(await canAccessAsset(tx, actor, id, `integration.${action}`))) throw new AccessDenied();
  }
  async function load(tx: AuthorizationTransaction, id: string) {
    const row = metadataRow
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT id, owning_team_id, name, enabled, generation, grants_version FROM ${relation(tx, 'tf_integrations')} WHERE id = $1 AND deleted_at IS NULL`,
            [uuidSchema.parse(id)],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function metadata(
    tx: AuthorizationTransaction,
    actor: Actor,
    row: z.infer<typeof metadataRow>,
  ): Promise<IntegrationMetadata> {
    return {
      id: row.id,
      name: row.name,
      owningTeamId: row.owning_team_id,
      enabled: row.enabled,
      generation: row.generation,
      grantsVersion: row.grants_version,
      capabilities: {
        read: await canAccessAsset(tx, actor, row.id, 'integration.read'),
        use: row.enabled && (await canAccessAsset(tx, actor, row.id, 'integration.use')),
        manage: await canAccessAsset(tx, actor, row.id, 'integration.manage'),
        administer: actor.kind === 'human' && (await canAccessAsset(tx, actor, row.id, 'integration.manage')),
      },
    };
  }
  async function detail(tx: AuthorizationTransaction, actor: Actor, id: string): Promise<IntegrationDetail> {
    const row = await load(tx, id);
    await permission(tx, actor, id, 'read');
    const value = await metadata(tx, actor, row);
    const sources = z
      .array(repositorySchema)
      .parse(
        (
          await tx.client.query(
            `SELECT id, owner, repo FROM ${relation(tx, 'tf_integration_sources')} WHERE integration_id = $1 ORDER BY owner, repo, id`,
            [id],
          )
        ).rows,
      );
    const repositories = await Promise.all(
      sources.map(async source => ({
        ...source,
        canReadIssues: value.capabilities.use && (await canAccessAsset(tx, actor, source.id, 'github.issue.read')),
      })),
    );
    if (!value.capabilities.administer) return { ...value, repositories };
    const grants = z
      .array(z.object({ teamId: uuidSchema, permissions: z.array(z.enum(['read', 'use', 'manage'])) }))
      .parse(
        (
          await tx.client.query(
            `SELECT team_id AS "teamId", array_agg(permission ORDER BY permission) AS permissions FROM ${relation(tx, 'tf_integration_grants')} WHERE integration_id = $1 GROUP BY team_id ORDER BY team_id`,
            [id],
          )
        ).rows,
      );
    const sourceGrants = z
      .array(z.object({ teamId: uuidSchema, sourceId: uuidSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT team_id AS "teamId", source_id AS "sourceId" FROM ${relation(tx, 'tf_integration_source_grants')} WHERE integration_id = $1 AND permission='github.issue.read' ORDER BY team_id, source_id`,
            [id],
          )
        ).rows,
      );
    const personGrants = z
      .array(z.object({ memberId: uuidSchema, permissions: z.array(z.enum(['read', 'use', 'manage'])) }))
      .parse(
        (
          await tx.client.query(
            `SELECT membership_id AS "memberId",array_agg(permission ORDER BY permission) AS permissions FROM ${relation(tx, 'tf_integration_person_grants')} WHERE integration_id=$1 GROUP BY membership_id ORDER BY membership_id`,
            [id],
          )
        ).rows,
      );
    const sourcePersonGrants = z
      .array(z.object({ memberId: uuidSchema, sourceId: uuidSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT membership_id AS "memberId",source_id AS "sourceId" FROM ${relation(tx, 'tf_integration_source_person_grants')} WHERE integration_id=$1 AND permission='github.issue.read' ORDER BY membership_id,source_id`,
            [id],
          )
        ).rows,
      );
    return {
      ...value,
      repositories,
      grants,
      sourceGrants,
      personGrants,
      sourcePersonGrants,
      ...(await investigationGrants(tx, id)),
    };
  }
  async function audit(tx: AuthorizationTransaction, actor: Actor, id: string, operation: string) {
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_audit_events')} (id, actor_id, operation, subject_id) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), actor.kind === 'human' ? actor.membershipId : actor.runId, `integration.${operation}`, id],
    );
  }
  async function team(tx: AuthorizationTransaction, id: string) {
    if (!(await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_teams')} WHERE id = $1`, [id])).rowCount)
      throw new AccessDenied();
  }
  async function authorizeIssue(tx: AuthorizationTransaction, actor: Actor, input: ReadIssue) {
    const row = await load(tx, input.integrationId);
    if (!row.enabled) throw new AccessDenied();
    await permission(tx, actor, input.integrationId, 'use');
    if (!(await canAccessAsset(tx, actor, input.sourceId, 'github.issue.read'))) throw new AccessDenied();
    const source = repositorySchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT id, owner, repo FROM ${relation(tx, 'tf_integration_sources')} WHERE integration_id = $1 AND id = $2`,
            [input.integrationId, input.sourceId],
          )
        ).rows[0],
      );
    if (!source) throw new AccessDenied();
    return source;
  }
  async function creationGrants(tx: AuthorizationTransaction, owningTeamId: string) {
    const rows = z
      .array(z.object({ team_id: uuidSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT team_id FROM ${relation(tx, 'tf_integration_creation_grants')} WHERE owning_team_id = $1 ORDER BY team_id`,
            [owningTeamId],
          )
        ).rows,
      );
    const teamIds = rows.map(row => row.team_id);
    return { owningTeamId, teamIds, version: createHash('sha256').update(JSON.stringify(teamIds)).digest('hex') };
  }
  return {
    async collaborators(workspaceId: string, principal: string | Actor) {
      return authorized(workspaceId, principal, 'read', async (tx, actor) => {
        if (actor.kind !== 'human') throw new AccessDenied();
        const members = z
          .array(z.object({ id: uuidSchema, name: z.string() }))
          .parse(
            (
              await tx.client.query(
                `SELECT id,user_id AS name FROM ${relation(tx, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY user_id,id`,
              )
            ).rows,
          );
        const teams = z
          .array(z.object({ id: uuidSchema, name: z.string() }))
          .parse(
            (
              await tx.client.query(
                `SELECT t.id,t.name FROM ${relation(tx, 'tf_teams')} t JOIN ${relation(tx, 'tf_member_teams')} mt ON mt.team_id=t.id WHERE mt.membership_id=$1 AND t.name NOT LIKE '\\_%' ORDER BY t.name,t.id`,
                [actor.membershipId],
              )
            ).rows,
          );
        return { members, teams };
      });
    },
    async creationGrants(workspaceId: string, principal: string | Actor, owningTeamId: string) {
      owningTeamId = uuidSchema.parse(owningTeamId);
      return authorized(workspaceId, principal, 'read', async (tx, actor) => {
        await teamManager(tx, actor, owningTeamId);
        await team(tx, owningTeamId);
        return creationGrants(tx, owningTeamId);
      });
    },
    async creationContext(workspaceId: string, principal: string | Actor) {
      return authorized(workspaceId, principal, 'read', async (tx, actor) => {
        if (actor.kind !== 'human') throw new AccessDenied();
        const rows = z
          .array(z.object({ id: uuidSchema, name: z.string() }))
          .parse(
            (
              await tx.client.query(
                `SELECT t.id,t.name FROM ${relation(tx, 'tf_teams')} t JOIN ${relation(tx, 'tf_member_teams')} mt ON mt.team_id=t.id WHERE mt.membership_id=$1 AND t.name NOT LIKE '\\_%' ORDER BY t.name,t.id`,
                [actor.membershipId],
              )
            ).rows,
          );
        const teams = [];
        for (const row of rows) teams.push(row);
        return { teams };
      });
    },
    async setCreationGrants(workspaceId: string, principal: string | Actor, input: unknown) {
      const value = updateCreationGrantsSchema.parse(input);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        await teamManager(tx, actor, value.owningTeamId);
        await team(tx, value.owningTeamId);
        const current = await creationGrants(tx, value.owningTeamId);
        if (value.expectedVersion !== undefined && value.expectedVersion !== current.version)
          throw new IntegrationError('conflict');
        for (const id of value.teamIds) await team(tx, id);
        const recommendations = await watchIntegrationRecommendations(tx, `creation:${value.owningTeamId}`, () =>
          integrationCreationRecommendations(tx, value.owningTeamId),
        );
        await tx.client.query(
          `DELETE FROM ${relation(tx, 'tf_integration_creation_grants')} WHERE owning_team_id = $1`,
          [value.owningTeamId],
        );
        for (const id of new Set(value.teamIds))
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_integration_creation_grants')} (team_id, owning_team_id) VALUES ($1,$2)`,
            [id, value.owningTeamId],
          );
        await audit(tx, actor, value.owningTeamId, 'creation-grants');
        await recommendations();
        return { owningTeamId: value.owningTeamId, teamIds: value.teamIds };
      });
    },
    async list(workspaceId: string, principal: string | Actor) {
      return authorized(workspaceId, principal, 'read', async (tx, actor) => {
        const rows = z
          .array(metadataRow)
          .parse(
            (
              await tx.client.query(
                `SELECT id, owning_team_id, name, enabled, generation, grants_version FROM ${relation(tx, 'tf_integrations')} WHERE deleted_at IS NULL ORDER BY name, id`,
              )
            ).rows,
          );
        const integrations: IntegrationMetadata[] = [];
        for (const row of rows)
          if (await canAccessAsset(tx, actor, row.id, 'integration.read'))
            integrations.push(await metadata(tx, actor, row));
        return { integrations };
      });
    },
    get(workspaceId: string, principal: string | Actor, id: string) {
      return authorized(workspaceId, principal, 'read', (tx, actor) => detail(tx, actor, uuidSchema.parse(id)));
    },
    async create(workspaceId: string, principal: string | Actor, input: unknown) {
      const value = createIntegrationSchema.parse(input);
      const intent = {
        name: value.name,
        owningTeamId: value.owningTeamId,
        repositories: [...value.repositories].sort((a, b) => a.id.localeCompare(b.id)),
        tokenHash: createHash('sha256').update(value.token).digest('hex'),
      };
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        await team(tx, value.owningTeamId);
        if (actor.kind === 'human')
          await validateIntegrationRecipients(tx, actor, { memberIds: [], teamIds: [value.owningTeamId] });
        else if (!(await canAccessAsset(tx, actor, value.owningTeamId, 'integration.create'))) throw new AccessDenied();
        const existing = await tx.client.query(
          `SELECT creation_intent = $2::jsonb AND created_by = $3::jsonb AND deleted_at IS NULL AS matches FROM ${relation(tx, 'tf_integrations')} WHERE id = $1`,
          [value.id, JSON.stringify(intent), JSON.stringify(actor)],
        );
        if (existing.rowCount) {
          if (!z.object({ matches: z.boolean() }).parse(existing.rows[0]).matches)
            throw new IntegrationError('conflict');
          await permission(tx, actor, value.id, 'read');
          return metadata(tx, actor, await load(tx, value.id));
        }
        const credential = cipher.encrypt(workspaceId, value.id, 1, value.token);
        const recommendations = await watchIntegrationRecommendations(tx, value.id, () =>
          integrationRecommendations(tx, value.id),
        );
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_integrations')} (id, owning_team_id, name, credential, creation_intent, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            value.id,
            value.owningTeamId,
            value.name,
            JSON.stringify(credential),
            JSON.stringify(intent),
            JSON.stringify(actor),
          ],
        );
        const creator =
          actor.kind === 'human'
            ? actor.membershipId
            : z
                .object({ membership_id: uuidSchema })
                .optional()
                .parse(
                  (
                    await tx.client.query(
                      `SELECT membership_id FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1 AND kind='delegated' AND membership_id IS NOT NULL`,
                      [actor.runId],
                    )
                  ).rows[0],
                )?.membership_id;
        if (!creator) throw new AccessDenied();
        for (const action of ['read', 'use', 'manage'])
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_integration_person_grants')} (integration_id,membership_id,permission) VALUES ($1,$2,$3)`,
            [value.id, creator, action],
          );
        for (const source of value.repositories)
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_integration_sources')} (id, integration_id, owner, repo) VALUES ($1,$2,$3,$4)`,
            [source.id, value.id, source.owner, source.repo],
          );
        await audit(tx, actor, value.id, 'create');
        await recommendations();
        return metadata(tx, actor, await load(tx, value.id));
      });
    },
    async rotate(workspaceId: string, principal: string | Actor, id: string, input: unknown) {
      id = uuidSchema.parse(id);
      const value = rotateIntegrationSchema.parse(input);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        await load(tx, id);
        await permission(tx, actor, id, 'manage');
        const credential = cipher.encrypt(workspaceId, id, value.expectedGeneration + 1, value.token);
        const changed = await tx.client.query(
          `UPDATE ${relation(tx, 'tf_integrations')} SET generation = generation + 1, credential = $3 WHERE id = $1 AND generation = $2`,
          [id, value.expectedGeneration, JSON.stringify(credential)],
        );
        if (!changed.rowCount) throw new IntegrationError('conflict');
        await audit(tx, actor, id, 'rotate');
        return detail(tx, actor, id);
      });
    },
    async update(workspaceId: string, principal: string | Actor, id: string, input: unknown) {
      id = uuidSchema.parse(id);
      const value = updateIntegrationSchema.parse(input);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        await load(tx, id);
        await permission(tx, actor, id, 'manage');
        const recommendations = await watchIntegrationRecommendations(tx, id, () => integrationRecommendations(tx, id));
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_integrations')} SET name = COALESCE($2, name), enabled = COALESCE($3, enabled) WHERE id = $1`,
          [id, value.name ?? null, value.enabled ?? null],
        );
        await audit(tx, actor, id, 'update');
        await recommendations();
        return detail(tx, actor, id);
      });
    },
    async setGrants(workspaceId: string, principal: string | Actor, id: string, input: unknown) {
      id = uuidSchema.parse(id);
      const value = integrationGrantsSchema.parse(input);
      return authorized(
        workspaceId,
        principal,
        'write',
        async (tx, actor) => {
          await permission(tx, actor, id, 'manage');
          await load(tx, id);
          if (actor.kind !== 'human') throw new AccessDenied();
          const recommendations = await watchIntegrationRecommendations(tx, id, () =>
            integrationRecommendations(tx, id),
          );
          const changed = await tx.client.query(
            `UPDATE ${relation(tx, 'tf_integrations')} SET grants_version = grants_version + 1 WHERE id = $1 AND grants_version = $2`,
            [id, value.expectedGrantsVersion],
          );
          if (!changed.rowCount) throw new IntegrationError('conflict');
          const retained = z
            .array(z.object({ team_id: uuidSchema }))
            .parse(
              (
                await tx.client.query(
                  `SELECT team_id FROM ${relation(tx, 'tf_integration_grants')} WHERE integration_id=$1 UNION SELECT team_id FROM ${relation(tx, 'tf_integration_source_grants')} WHERE integration_id=$1`,
                  [id],
                )
              ).rows,
            )
            .map(row => row.team_id);
          await validateIntegrationRecipients(
            tx,
            actor,
            {
              memberIds: [
                ...(value.personGrants ?? []).map(g => g.memberId),
                ...(value.sourcePersonGrants ?? []).map(g => g.memberId),
                ...(value.investigationPersonGrants ?? []).map(g => g.memberId),
              ],
              teamIds: [...value.grants, ...value.sourceGrants, ...(value.investigationGrants ?? [])].map(
                g => g.teamId,
              ),
            },
            retained,
          );
          for (const grant of [...value.grants, ...value.sourceGrants]) await team(tx, grant.teamId);
          for (const grant of value.sourceGrants)
            if (
              !(
                await tx.client.query(
                  `SELECT 1 FROM ${relation(tx, 'tf_integration_sources')} WHERE id = $1 AND integration_id = $2`,
                  [grant.sourceId, id],
                )
              ).rowCount
            )
              throw new AccessDenied();
          for (const grant of value.sourcePersonGrants ?? [])
            if (
              !(
                await tx.client.query(
                  `SELECT 1 FROM ${relation(tx, 'tf_integration_sources')} WHERE id=$1 AND integration_id=$2`,
                  [grant.sourceId, id],
                )
              ).rowCount
            )
              throw new AccessDenied();
          await tx.client.query(`DELETE FROM ${relation(tx, 'tf_integration_grants')} WHERE integration_id = $1`, [id]);
          await tx.client.query(
            `DELETE FROM ${relation(tx, 'tf_integration_source_grants')} WHERE integration_id = $1 AND permission='github.issue.read'`,
            [id],
          );
          for (const grant of value.grants)
            for (const action of grant.permissions)
              await tx.client.query(
                `INSERT INTO ${relation(tx, 'tf_integration_grants')} (integration_id, team_id, permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [id, grant.teamId, action],
              );
          for (const grant of value.sourceGrants)
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_integration_source_grants')} (integration_id, team_id, source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
              [id, grant.teamId, grant.sourceId],
            );
          if (value.personGrants) {
            await tx.client.query(
              `DELETE FROM ${relation(tx, 'tf_integration_person_grants')} WHERE integration_id=$1`,
              [id],
            );
            for (const grant of value.personGrants)
              for (const action of grant.permissions)
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_integration_person_grants')} (integration_id,membership_id,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                  [id, grant.memberId, action],
                );
          }
          if (value.sourcePersonGrants) {
            await tx.client.query(
              `DELETE FROM ${relation(tx, 'tf_integration_source_person_grants')} WHERE integration_id=$1 AND permission='github.issue.read'`,
              [id],
            );
            for (const grant of value.sourcePersonGrants)
              await tx.client.query(
                `INSERT INTO ${relation(tx, 'tf_integration_source_person_grants')} (integration_id,membership_id,source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [id, grant.memberId, grant.sourceId],
              );
          }
          await replaceInvestigationGrants(tx, id, value);
          const managers = await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_memberships')} m WHERE m.removed_at IS NULL AND (EXISTS (SELECT 1 FROM ${relation(tx, 'tf_integration_person_grants')} g WHERE g.integration_id=$1 AND g.membership_id=m.id AND g.permission='manage') OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_integration_grants')} g JOIN ${relation(tx, 'tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.integration_id=$1 AND g.permission='manage' AND mt.membership_id=m.id)) LIMIT 1`,
            [id],
          );
          if (!managers.rowCount) throw new AccessDenied();
          await audit(tx, actor, id, 'grants');
          await recommendations();
          if (await canAccessAsset(tx, actor, id, 'integration.read')) return detail(tx, actor, id);
          return { ...(await metadata(tx, actor, await load(tx, id))), repositories: [] };
        },
        value.investigationGrants !== undefined || value.investigationPersonGrants !== undefined
          ? 42
          : integrationCompatibility.minimum,
      );
    },
    async transfer(workspaceId: string, principal: string | Actor, id: string, input: unknown) {
      id = uuidSchema.parse(id);
      const value = transferIntegrationSchema.parse(input);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        await permission(tx, actor, id, 'manage');
        await load(tx, id);
        await team(tx, value.owningTeamId);
        if (actor.kind !== 'human') throw new AccessDenied();
        await validateIntegrationRecipients(tx, actor, { memberIds: [], teamIds: [value.owningTeamId] });
        const recommendations = await watchIntegrationRecommendations(tx, id, () => integrationRecommendations(tx, id));
        await tx.client.query(`UPDATE ${relation(tx, 'tf_integrations')} SET owning_team_id = $2 WHERE id = $1`, [
          id,
          value.owningTeamId,
        ]);
        await audit(tx, actor, id, 'transfer');
        await recommendations();
        return detail(tx, actor, id);
      });
    },
    async remove(workspaceId: string, principal: string | Actor, id: string) {
      id = uuidSchema.parse(id);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        await load(tx, id);
        await permission(tx, actor, id, 'manage');
        const recommendations = await watchIntegrationRecommendations(tx, id, () => integrationRecommendations(tx, id));
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_integrations')} SET deleted_at = clock_timestamp(), enabled = false, credential = NULL WHERE id = $1`,
          [id],
        );
        await audit(tx, actor, id, 'remove');
        await recommendations();
        return { removed: true };
      });
    },
    async readIssue(workspaceId: string, principal: string | Actor, input: ReadIssue) {
      denyMcpEgress();
      workspaceId = uuidSchema.parse(workspaceId);
      const value = readIssueSchema.parse(input);
      const prepared = await authorized(workspaceId, principal, 'read', async (tx, actor) => {
        await requireNoMcpDerived(tx, [], actor);
        await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `integration-dispatch:${workspaceId}:${value.requestId}`,
        ]);
        await requirePersistedIssueCall(tx, actor, value);
        await tx.client.query(`SELECT id FROM ${relation(tx, 'tf_integrations')} WHERE id = $1 FOR UPDATE`, [
          value.integrationId,
        ]);
        const source = await authorizeIssue(tx, actor, value);
        const existing = dispatchSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT *, started_at < clock_timestamp() - interval '60 seconds' AS stale FROM ${relation(tx, 'tf_integration_dispatches')} WHERE request_id = $1 FOR UPDATE`,
                [value.requestId],
              )
            ).rows[0],
          );
        if (
          existing &&
          (JSON.stringify(existing.actor) !== JSON.stringify(actor) ||
            existing.integration_id !== value.integrationId ||
            existing.source_id !== value.sourceId ||
            existing.issue_number !== value.issueNumber)
        )
          throw new IntegrationError('conflict');
        if (existing?.status === 'completed')
          return { kind: 'completed', result: issueResultSchema.parse(existing.result), actor } as const;
        if (existing?.status === 'executing') {
          if (existing.stale) {
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_integration_dispatches')} SET status = 'failed', attempt = 3 WHERE request_id = $1`,
              [value.requestId],
            );
            return { kind: 'failed' } as const;
          }
          return { kind: 'in-progress' } as const;
        }
        if (existing && existing.attempt >= 3) return { kind: 'failed' } as const;
        const credential = z
          .object({ generation: z.number().int(), credential: z.unknown() })
          .parse(
            (
              await tx.client.query(
                `SELECT generation, credential FROM ${relation(tx, 'tf_integrations')} WHERE id = $1`,
                [value.integrationId],
              )
            ).rows[0],
          );
        const attempt = (existing?.attempt ?? 0) + 1;
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_integration_dispatches')} (request_id, integration_id, source_id, actor, issue_number, generation, status, attempt) VALUES ($1,$2,$3,$4,$5,$6,'executing',$7) ON CONFLICT (request_id) DO UPDATE SET status = 'executing', attempt = $7, generation = $6, started_at = clock_timestamp()`,
          [
            value.requestId,
            value.integrationId,
            value.sourceId,
            JSON.stringify(actor),
            value.issueNumber,
            credential.generation,
            attempt,
          ],
        );
        await audit(tx, actor, value.requestId, 'dispatch');
        return { kind: 'dispatch', source, credential, attempt, actor } as const;
      });
      if (prepared.kind === 'failed') throw new IntegrationError('provider-failed');
      if (prepared.kind === 'in-progress') throw new IntegrationError('in-progress');
      if (prepared.kind === 'completed') return prepared.result;
      let result;
      try {
        const token = cipher.decrypt(
          workspaceId,
          value.integrationId,
          prepared.credential.generation,
          prepared.credential.credential,
        );
        result = await fetchIssue(
          { ...prepared.source, issueNumber: value.issueNumber, token },
          options.providerFetch ?? fetch,
        );
      } catch {
        const failed = await options.runtime.transaction(workspaceId, integrationCompatibility, async tx => {
          await lockAuthorization(tx);
          return (
            (
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_integration_dispatches')} SET status = 'failed' WHERE request_id = $1 AND attempt = $2 AND status = 'executing'`,
                [value.requestId, prepared.attempt],
              )
            ).rowCount === 1
          );
        });
        throw new IntegrationError(failed && prepared.attempt < 3 ? 'provider-retryable' : 'provider-failed');
      }
      const completed = await options.runtime.transaction(workspaceId, integrationCompatibility, async tx => {
        await lockAuthorization(tx);
        return (
          (
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_integration_dispatches')} SET status = 'completed', result = $3 WHERE request_id = $1 AND attempt = $2 AND status = 'executing'`,
              [value.requestId, prepared.attempt, JSON.stringify(result)],
            )
          ).rowCount === 1
        );
      });
      if (!completed) throw new IntegrationError('provider-failed');
      return authorized(workspaceId, prepared.actor, 'read', async (tx, actor) => {
        await authorizeIssue(tx, actor, value);
        return issueResultSchema.parse(result);
      });
    },
  };
}
export type IntegrationService = ReturnType<typeof createIntegrationService>;
