import { escapeIdentifier, type Client } from 'pg';
import { z } from 'zod';
import {
  actorSchema,
  assetPermissionSchema,
  uuidSchema,
  type Actor,
  type HumanActor,
  type TablePermission,
  type AssetPermission,
} from './contracts.ts';
import type { SourceDependency } from './source-dependencies.ts';
import { requireAgentGrant, requireAgentRunInvocation } from './agent-permissions.ts';
export * from './agent-permissions.ts';
export * from './contracts.ts';
export * from './source-dependencies.ts';
export * from './github-source.ts';
export * from './github-task.ts';
export * from './github-read.ts';
export * from './mcp-provenance.ts';
export * from './mcp-source.ts';
export * from './protected-source.ts';
export * from './workflow-source.ts';
export * from './team-permissions.ts';
export * from './manager-handoff.ts';
export type AuthorizationTransaction = {
  client: Pick<Client, 'query'>;
  schema: string;
  requireGitHubSource?: GitHubSourceCheck;
  requireTeamGitHubSource?: (
    actor: HumanActor,
    source: Extract<SourceDependency, { kind: 'github-source' }>,
  ) => Promise<void>;
  requireGitHubSourceAccess?: GitHubSourceCheck;
  requireKnowledgeSource?: (
    actor: HumanActor,
    source: Extract<SourceDependency, { kind: 'knowledge-document' }>,
    context: { runId?: string; publicOnly: boolean },
  ) => Promise<void>;
  requireTulipFarmFile?: (actor: HumanActor, reference: { fileId: string }) => Promise<void>;
  knowledgeSourceDependencies?: (
    source: Extract<SourceDependency, { kind: 'knowledge-document' }>,
  ) => Promise<SourceDependency[]>;
};
type GitHubSourceCheck = (
  actor: HumanActor,
  source: Extract<import('./source-dependencies.ts').SourceDependency, { kind: 'github-personal' }>,
) => Promise<void>;
const membershipSchema = z.object({ id: uuidSchema, user_id: z.string(), role: z.enum(['admin', 'member']) });

export class AccessDenied extends Error {
  constructor() {
    super('Resource not found');
  }
}

export class SourceAuthorizationUnavailable extends AccessDenied {}

function table(transaction: AuthorizationTransaction, name: string) {
  return `${escapeIdentifier(transaction.schema)}.${escapeIdentifier(name)}`;
}

export async function lockAuthorization(transaction: AuthorizationTransaction, mode: 'read' | 'write' = 'read') {
  const result = await transaction.client.query(
    `SELECT id FROM ${table(transaction, 'tf_authorization_lock')} WHERE id = 1 FOR ${mode === 'write' ? 'UPDATE' : 'SHARE'}`,
  );
  if (result.rowCount !== 1) throw new AccessDenied();
}

export async function resolveHuman(transaction: AuthorizationTransaction, userId: string): Promise<HumanActor> {
  const result = await transaction.client.query(
    `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE user_id = $1 AND removed_at IS NULL`,
    [userId],
  );
  const member = membershipSchema.optional().parse(result.rows[0]);
  if (!member) throw new AccessDenied();
  return { kind: 'human', userId: member.user_id, membershipId: member.id };
}

export async function currentMember(transaction: AuthorizationTransaction, actor: HumanActor) {
  const result = await transaction.client.query(
    `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [actor.membershipId, actor.userId],
  );
  const member = membershipSchema.optional().parse(result.rows[0]);
  if (!member) throw new AccessDenied();
  return member;
}

export async function requireTaskInvocation(transaction: AuthorizationTransaction, actor: HumanActor, agentId: string) {
  await requireAgentGrant(transaction, actor, agentId, 'invoke');
}

export async function canAccessTable(
  transaction: AuthorizationTransaction,
  actor: Actor,
  assetId: string,
  permission: TablePermission,
): Promise<boolean> {
  return canAccessAsset(transaction, actor, assetId, permission);
}

export async function tablePersonGrantsInstalled(transaction: AuthorizationTransaction) {
  const result = await transaction.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
    table(transaction, 'tf_table_person_grants'),
  ]);
  return z.object({ installed: z.boolean() }).parse(result.rows[0]).installed;
}

// Expressions are trusted SQL from callers, never request input. Values stay parameterized.
export async function humanTableGrantPredicate(
  transaction: AuthorizationTransaction,
  expressions: { membershipId: string; assetId: string; permissions: string },
) {
  const { membershipId, assetId, permissions } = expressions;
  const team = `EXISTS (SELECT 1 FROM ${table(transaction, 'tf_member_teams')} mt
    JOIN ${table(transaction, 'tf_grants')} g ON g.team_id = mt.team_id
    WHERE mt.membership_id = ${membershipId} AND g.asset_id = ${assetId} AND g.permission = ANY(${permissions}))`;
  const alternatives = [team];
  if (await tablePersonGrantsInstalled(transaction))
    alternatives.push(`EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_person_grants')} pg
    WHERE pg.membership_id = ${membershipId} AND pg.asset_id = ${assetId} AND pg.permission = ANY(${permissions}))`);
  const installed = (
    await transaction.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
      table(transaction, 'tf_system_tables'),
    ])
  ).rows[0]?.installed;
  if (installed)
    alternatives.push(`('table.row.read'=ANY(${permissions}) AND EXISTS (
    SELECT 1 FROM ${table(transaction, 'tf_system_tables')} directory
    JOIN ${table(transaction, 'tf_memberships')} reader ON reader.id=${membershipId} AND reader.removed_at IS NULL
    WHERE directory.kind='workspace-members' AND directory.table_id=${assetId}))`);
  return `(${alternatives.join(' OR ')})`;
}

function grantTarget(permission: AssetPermission) {
  if (permission.startsWith('github.'))
    return {
      name: 'tf_integration_source_grants',
      column: 'source_id',
      permission,
      people: 'tf_integration_source_person_grants',
    };
  if (permission === 'integration.create')
    return { name: 'tf_integration_creation_grants', column: 'owning_team_id', permission, people: null };
  if (permission.startsWith('integration.'))
    return {
      name: 'tf_integration_grants',
      column: 'integration_id',
      permission: permission.slice('integration.'.length),
      people: 'tf_integration_person_grants',
    };
  return { name: 'tf_grants', column: 'asset_id', permission, people: null };
}

// Workspace admins administer resources. Every other asset requires an explicit person or team grant.
export async function canAccessAsset(
  transaction: AuthorizationTransaction,
  actor: Actor,
  assetId: string,
  permission: AssetPermission,
): Promise<boolean> {
  actor = actorSchema.parse(actor);
  assetId = uuidSchema.parse(assetId);
  if (
    (permission === 'integration.use' || permission === 'integration.manage') &&
    !(await canAccessAsset(transaction, actor, assetId, 'integration.read'))
  )
    return false;
  if (actor.kind === 'agent') return canAgentAccess(transaction, actor.runId, assetId, permission);
  const member = await currentMember(transaction, actor);
  if (permission.startsWith('table.')) {
    if (member.role === 'admin') return true;
    const predicate = await humanTableGrantPredicate(transaction, {
      membershipId: '$1',
      assetId: '$2',
      permissions: '$3::text[]',
    });
    const result = await transaction.client.query(`SELECT 1 WHERE ${predicate}`, [
      actor.membershipId,
      assetId,
      [permission],
    ]);
    return result.rowCount === 1;
  }
  const target = grantTarget(permission);
  const person = target.people
    ? `SELECT 1 FROM ${table(transaction, target.people)} p WHERE p.membership_id = $1 AND p.${target.column} = $2 AND p.permission = $3 UNION ALL `
    : '';
  const result = await transaction.client.query(
    `${person}SELECT 1 FROM ${table(transaction, 'tf_member_teams')} mt JOIN ${table(transaction, target.name)} g ON g.team_id = mt.team_id WHERE mt.membership_id = $1 AND g.${target.column} = $2 AND g.permission = $3 LIMIT 1`,
    [actor.membershipId, assetId, target.permission],
  );
  return Boolean(result.rowCount);
}

export async function requireTablePermission(
  transaction: AuthorizationTransaction,
  actor: Actor,
  assetId: string,
  permission: TablePermission,
) {
  if (!(await canAccessTable(transaction, actor, assetId, permission))) throw new AccessDenied();
}

export async function requireTableCreation(transaction: AuthorizationTransaction, actor: Actor, teamId: string) {
  const team = await transaction.client.query(`SELECT id FROM ${table(transaction, 'tf_teams')} WHERE id = $1`, [
    teamId,
  ]);
  if (!team.rowCount) throw new AccessDenied();
  await requireTablePermission(transaction, actor, teamId, 'table.create');
}

const scopeSchema = z.array(z.strictObject({ assetId: uuidSchema, permissions: z.array(assetPermissionSchema) }));
const runSchema = z.object({
  id: uuidSchema,
  agent_id: uuidSchema,
  activation_id: uuidSchema,
  definition_revision: z.string(),
  kind: z.enum(['delegated', 'scheduled']),
  user_id: z.string().nullable(),
  membership_id: uuidSchema.nullable(),
  schedule_id: uuidSchema.nullable(),
  scope: scopeSchema,
  status: z.enum(['ready', 'running', 'waiting', 'completed', 'blocked', 'cancelled']),
  task_id: uuidSchema.nullish(),
});

async function agentAuthority(transaction: AuthorizationTransaction, runId: string) {
  const row = (
    await transaction.client.query(
      `SELECT r.*, a.enabled, v.scope AS activation_scope, l.scope AS limit_scope FROM ${table(transaction, 'tf_agent_runs')} r JOIN ${table(transaction, 'tf_agents')} a ON a.id = r.agent_id JOIN ${table(transaction, 'tf_agent_activations')} v ON v.id = r.activation_id AND v.agent_id = r.agent_id AND v.definition_revision = r.definition_revision JOIN ${table(transaction, 'tf_agent_limits')} l ON l.agent_id = r.agent_id WHERE r.id = $1 AND v.revoked_at IS NULL`,
      [runId],
    )
  ).rows[0];
  const authority = runSchema
    .extend({ enabled: z.boolean(), activation_scope: scopeSchema, limit_scope: scopeSchema })
    .optional()
    .parse(row);
  if (!authority || !authority.enabled || !['ready', 'running', 'waiting'].includes(authority.status))
    throw new AccessDenied();
  if (
    !(
      await transaction.client.query(
        `SELECT 1 FROM ${table(transaction, 'tf_agents')} WHERE id = $1 AND saved_revision IS NOT NULL AND deleted_at IS NULL`,
        [authority.agent_id],
      )
    ).rowCount
  )
    throw new AccessDenied();
  if (authority.kind === 'delegated') {
    if (!authority.user_id || !authority.membership_id || authority.schedule_id) throw new AccessDenied();
    await currentMember(transaction, {
      kind: 'human',
      userId: authority.user_id,
      membershipId: authority.membership_id,
    });
    await requireAgentRunInvocation(
      transaction,
      { kind: 'human', userId: authority.user_id, membershipId: authority.membership_id },
      authority.agent_id,
      runId,
    );
    return { authority, scheduledScope: null, sponsor: null };
  }
  if (!authority.schedule_id || authority.user_id || authority.membership_id) throw new AccessDenied();
  const schedule = z
    .object({ scope: scopeSchema, membership_id: uuidSchema, user_id: z.string() })
    .optional()
    .parse(
      (
        await transaction.client.query(
          `SELECT s.scope,m.id AS membership_id,m.user_id FROM ${table(transaction, 'tf_agent_schedules')} s JOIN ${table(transaction, 'tf_memberships')} m ON m.id=s.sponsor_membership_id AND m.removed_at IS NULL JOIN ${table(transaction, 'tf_agent_runs')} r ON r.id=$3 AND r.sponsor_membership_id=m.id WHERE s.id = $1 AND s.activation_id = $2 AND s.revoked_at IS NULL AND s.paused_at IS NULL`,
          [authority.schedule_id, authority.activation_id, runId],
        )
      ).rows[0],
    );
  if (!schedule) throw new AccessDenied();
  const sponsor: HumanActor = { kind: 'human', userId: schedule.user_id, membershipId: schedule.membership_id };
  await requireTaskInvocation(transaction, sponsor, authority.agent_id);
  return { authority, scheduledScope: schedule.scope, sponsor };
}

export async function requireCurrentActor(transaction: AuthorizationTransaction, actor: Actor) {
  if (actor.kind === 'human') await currentMember(transaction, actor);
  else await agentAuthority(transaction, actor.runId);
}

/** The person whose access bounds a run: the delegating member, or the current sponsor of a scheduled run. */
export async function agentRunOwner(transaction: AuthorizationTransaction, runId: string): Promise<HumanActor> {
  const { authority, sponsor } = await agentAuthority(transaction, runId);
  if (sponsor) return sponsor;
  if (!authority.user_id || !authority.membership_id) throw new AccessDenied();
  return { kind: 'human', userId: authority.user_id, membershipId: authority.membership_id };
}

export async function queryHumanContext(
  transaction: AuthorizationTransaction,
  actor: Actor,
): Promise<HumanActor | null> {
  if (actor.kind === 'human') {
    await currentMember(transaction, actor);
    return actor;
  }
  const { authority } = await agentAuthority(transaction, actor.runId);
  // Sponsoring a schedule does not make its autonomous query a request from "me".
  if (authority.kind !== 'delegated') return null;
  if (!authority.user_id || !authority.membership_id) throw new AccessDenied();
  return { kind: 'human', userId: authority.user_id, membershipId: authority.membership_id };
}

export async function resolveActor(transaction: AuthorizationTransaction, principal: string | Actor): Promise<Actor> {
  if (typeof principal === 'string') return resolveHuman(transaction, principal);
  const actor = actorSchema.parse(principal);
  await requireCurrentActor(transaction, actor);
  return actor;
}

export async function requirePersistedIssueCall(
  transaction: AuthorizationTransaction,
  actor: Actor,
  input: { requestId: string; integrationId: string; sourceId: string; issueNumber: number },
) {
  actor = actorSchema.parse(actor);
  if (actor.kind !== 'agent') return;
  await transaction.client.query(`SELECT id FROM ${table(transaction, 'tf_agent_runs')} WHERE id = $1 FOR UPDATE`, [
    actor.runId,
  ]);
  const { authority } = await agentAuthority(transaction, actor.runId);
  const call = {
    tool: 'github.issue.read',
    integrationId: uuidSchema.parse(input.integrationId),
    sourceId: uuidSchema.parse(input.sourceId),
    issueNumber: input.issueNumber,
  };
  const result = await transaction.client.query(
    `SELECT 1 FROM ${table(transaction, 'tf_agent_tool_calls')} c
    JOIN ${table(transaction, 'tf_agent_definitions')} d ON d.agent_id = $4 AND d.revision = $5
    WHERE c.id = $1 AND c.run_id = $2 AND c.call = $3::jsonb AND c.status IN ('pending', 'waiting', 'completed')
      AND d.definition->'tools' ? 'github.issue.read'
      AND NOT EXISTS (SELECT 1 FROM ${table(transaction, 'tf_agent_tool_calls')} predecessor WHERE predecessor.run_id = c.run_id AND predecessor.sequence < c.sequence AND predecessor.status <> 'completed')`,
    [input.requestId, actor.runId, JSON.stringify(call), authority.agent_id, authority.definition_revision],
  );
  if (!result.rowCount) throw new AccessDenied();
}

async function canAgentAccess(
  transaction: AuthorizationTransaction,
  runId: string,
  assetId: string,
  permission: AssetPermission,
) {
  const { authority, scheduledScope, sponsor } = await agentAuthority(transaction, runId);
  const permits = (scope: z.infer<typeof scopeSchema>) =>
    scope.some(entry => entry.assetId === assetId && entry.permissions.includes(permission));
  if (
    ![authority.scope, authority.activation_scope, authority.limit_scope].every(permits) ||
    (scheduledScope && !permits(scheduledScope))
  )
    return false;
  const target = grantTarget(permission);
  const grant = await transaction.client.query(
    `SELECT 1 FROM ${table(transaction, 'tf_agent_teams')} t JOIN ${table(transaction, target.name)} g ON g.team_id = t.team_id WHERE t.agent_id = $1 AND g.${target.column} = $2 AND g.permission = $3 LIMIT 1`,
    [authority.agent_id, assetId, target.permission],
  );
  if (!grant.rowCount) return false;
  if (sponsor) return canAccessAsset(transaction, sponsor, assetId, permission);
  if (!authority.user_id || !authority.membership_id) return false;
  return canAccessAsset(
    transaction,
    { kind: 'human', userId: authority.user_id, membershipId: authority.membership_id },
    assetId,
    permission,
  );
}
