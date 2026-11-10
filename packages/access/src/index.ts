import { setTimeout as delay } from 'node:timers/promises';
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
export * from './remote-checks.ts';
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
  /** `item` accepts any readable Files item, folders included, rather than only a readable file. */
  requireTulipFarmFile?: (
    actor: HumanActor,
    reference: { fileId: string; item?: boolean; cited?: boolean },
  ) => Promise<void>;
  requireWorkflowSource?: (
    actor: HumanActor,
    source: Extract<SourceDependency, { kind: 'workflow-definition' | 'workflow-provider' }>,
  ) => Promise<void>;
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

const lockAttempts = 3;

/**
 * Takes the workspace authorization lock, shared for reads and exclusive for writes.
 *
 * Postgres lets a new shared row lock past a queued exclusive one, so steady reads could hold off a write forever.
 * Every caller therefore queues on a matching advisory lock first, which Postgres grants in arrival order. A write
 * that times out or deadlocks waiting rolls back to a savepoint taken just before the wait and tries again, so
 * nothing else in the transaction is repeated or lost. A caller that retries its whole transaction passes
 * `retry: false`.
 */
export async function lockAuthorization(
  transaction: AuthorizationTransaction,
  mode: 'read' | 'write' = 'read',
  { retry = true }: { retry?: boolean } = {},
) {
  // The row is locked only after the join has produced it, so the queue is always joined first.
  const take = () =>
    transaction.client.query(
      `SELECT authorization_lock.id FROM (SELECT ${mode === 'write' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1, 518204))) queue, ${table(transaction, 'tf_authorization_lock')} authorization_lock WHERE authorization_lock.id = 1 FOR ${mode === 'write' ? 'UPDATE' : 'SHARE'} OF authorization_lock`,
      [transaction.schema],
    );
  const result = mode === 'write' && retry ? await retryLockWait(transaction, take) : await take();
  if (result.rowCount !== 1) throw new AccessDenied();
}

async function retryLockWait<T>(transaction: AuthorizationTransaction, take: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    await transaction.client.query('SAVEPOINT tf_authorization_lock');
    try {
      const result = await take();
      await transaction.client.query('RELEASE SAVEPOINT tf_authorization_lock');
      return result;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (attempt >= lockAttempts || (code !== '55P03' && code !== '40P01')) throw error;
      await transaction.client.query('ROLLBACK TO SAVEPOINT tf_authorization_lock');
      await delay(50 * attempt * (0.5 + Math.random()));
    }
  }
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
  if (['table.row.create', 'table.row.update', 'table.row.delete'].includes(permission)) {
    const installed = (
      await transaction.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
        table(transaction, 'tf_system_package_installations'),
      ])
    ).rows[0]?.installed;
    if (
      installed &&
      (
        await transaction.client.query(
          `SELECT 1 FROM ${table(transaction, 'tf_system_package_installations')} i,
        LATERAL jsonb_array_elements(i.nodes) node
       WHERE node->>'kind'='table' AND node->>'resourceId'=$1
         AND node->>'state'<>'completed' LIMIT 1`,
          [assetId],
        )
      ).rowCount
    )
      return false;
  }
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
  // Only a delegated run acts; scheduled runs are history left from removed agent schedules.
  if (authority.kind !== 'delegated' || !authority.user_id || !authority.membership_id) throw new AccessDenied();
  const owner: HumanActor = { kind: 'human', userId: authority.user_id, membershipId: authority.membership_id };
  await currentMember(transaction, owner);
  await requireAgentRunInvocation(transaction, owner, authority.agent_id, runId);
  return { authority, owner };
}

export async function requireCurrentActor(transaction: AuthorizationTransaction, actor: Actor) {
  if (actor.kind === 'human') await currentMember(transaction, actor);
  else await agentAuthority(transaction, actor.runId);
}

/** The person whose access bounds a run: its delegating member. */
export async function agentRunOwner(transaction: AuthorizationTransaction, runId: string): Promise<HumanActor> {
  return (await agentAuthority(transaction, runId)).owner;
}

export async function queryHumanContext(
  transaction: AuthorizationTransaction,
  actor: Actor,
): Promise<HumanActor | null> {
  if (actor.kind === 'human') {
    await currentMember(transaction, actor);
    return actor;
  }
  return (await agentAuthority(transaction, actor.runId)).owner;
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
  const { authority, owner } = await agentAuthority(transaction, runId);
  const permits = (scope: z.infer<typeof scopeSchema>) =>
    scope.some(entry => entry.assetId === assetId && entry.permissions.includes(permission));
  if (![authority.scope, authority.activation_scope, authority.limit_scope].every(permits)) return false;
  const target = grantTarget(permission);
  const grant = await transaction.client.query(
    `SELECT 1 FROM ${table(transaction, 'tf_agent_teams')} t JOIN ${table(transaction, target.name)} g ON g.team_id = t.team_id WHERE t.agent_id = $1 AND g.${target.column} = $2 AND g.permission = $3 LIMIT 1`,
    [authority.agent_id, assetId, target.permission],
  );
  if (!grant.rowCount) return false;
  return canAccessAsset(transaction, owner, assetId, permission);
}
