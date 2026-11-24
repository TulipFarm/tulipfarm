import { setTimeout as delay } from 'node:timers/promises';
import { escapeIdentifier, type Client } from 'pg';
import { z } from 'zod';
import { recordAuthorizationLock } from '@tulipfarm/observability';
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
import {
  forgetInTransaction,
  knownInTransaction,
  memoizeInTransaction,
  pipelined,
  relationInstalled,
  rememberInTransaction,
} from '@tulipfarm/workspace-storage/transaction-reads';
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
  /**
   * The transaction only reads and writes nothing. Its GitHub chat and account checks then read the rows without the
   * locks that writing callers take, so concurrent readers and a running reply do not queue behind one another.
   */
  readOnly?: boolean;
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

/** Denies an actor kind a `switch` does not name. Typed `never` so a new kind fails the build at every such switch. */
export function unhandledActor(_actor: never): never {
  throw new AccessDenied();
}

export class WorkspaceMembershipDenied extends AccessDenied {
  readonly userId: string;

  constructor(userId: string) {
    super();
    this.userId = userId;
  }
}

export class SourceAuthorizationUnavailable extends AccessDenied {}
export class SkillUnavailable extends AccessDenied {
  readonly code = 'skill-unavailable';
}
/** Refuses another member's personal memory, so callers can say why instead of reporting a missing resource. */
export class PersonalMemoryDenied extends AccessDenied {}
/**
 * Refuses a step that could carry data from a connected MCP integration to another tool or outside service. It is a
 * data-protection rule, not missing access, so callers can explain it instead of reporting a missing resource.
 */
export class McpEgressDenied extends AccessDenied {
  readonly code = 'mcp-egress-denied';
}

function table(transaction: AuthorizationTransaction, name: string) {
  return `${escapeIdentifier(transaction.schema)}.${escapeIdentifier(name)}`;
}

/** How long one lock acquisition may keep retrying waits that time out, before the last error is returned. */
const lockBudgetMs = 15_000;

/**
 * Takes the workspace authorization lock, shared for reads and exclusive for writes.
 *
 * Postgres lets a new shared row lock past a queued exclusive one, so steady reads could hold off a write forever.
 * Every caller therefore queues on a matching advisory lock first, which Postgres grants in arrival order.
 *
 * A wait that hits `lock_timeout` or a deadlock rolls back to a savepoint taken just before it and tries again after
 * a jittered backoff, until about 15 seconds have passed; the last wait can run past that by up to one
 * `lock_timeout`. Only the lock statement is repeated, so nothing else in the transaction is repeated or lost, which
 * makes the retry safe for reads and writes alike. A read first tries the lock without waiting, so the usual
 * uncontended read needs no savepoint. A caller that retries its whole transaction passes `retry: false`.
 */
export async function lockAuthorization(
  transaction: AuthorizationTransaction,
  mode: 'read' | 'write' = 'read',
  options: { retry?: boolean; budgetMs?: number } = {},
) {
  await takeAuthorizationLock(transaction, mode, options);
  heldLock(transaction, mode);
}

async function takeAuthorizationLock(
  transaction: AuthorizationTransaction,
  mode: 'read' | 'write',
  { retry = true, budgetMs = lockBudgetMs }: { retry?: boolean; budgetMs?: number },
) {
  const take = waitForLock(transaction, mode);
  if (!retry) {
    if ((await take()).rowCount !== 1) throw new AccessDenied();
    return;
  }
  if (mode === 'read') {
    const free = await tryReadLock(transaction);
    if (free.rowCount === 1) {
      recordAuthorizationLock(mode, 'acquired', 0, 0);
      return;
    }
  }
  if ((await retryLockWait(transaction, mode, budgetMs, take)).taken.rowCount !== 1) throw new AccessDenied();
}

/**
 * Other transactions change memberships only under the exclusive lock, so once this transaction holds either lock each
 * member it reads stays as read. This transaction's own membership writes call `forgetMembers`.
 */
function heldLock(transaction: AuthorizationTransaction, mode: 'read' | 'write') {
  rememberInTransaction(transaction.client, `authorization:${mode}`, true);
}

function membersStable(transaction: AuthorizationTransaction) {
  return (
    knownInTransaction(transaction.client, 'authorization:read') ||
    knownInTransaction(transaction.client, 'authorization:write')
  );
}

/** Drops members read earlier in this transaction. Call it after every write to `tf_memberships`. */
export function forgetMembers(transaction: AuthorizationTransaction) {
  forgetInTransaction(transaction.client, 'member:');
}

function rememberMember(transaction: AuthorizationTransaction, member: z.infer<typeof membershipSchema>) {
  if (!membersStable(transaction)) return;
  rememberInTransaction(transaction.client, `member:${member.id}:${member.user_id}`, member);
  rememberInTransaction(transaction.client, `member:user:${member.user_id}`, member);
}

// The row is locked only after the join has produced it, so the queue is always joined first.
const waitForLock = (transaction: AuthorizationTransaction, mode: 'read' | 'write') => () =>
  transaction.client.query(
    `SELECT authorization_lock.id FROM (SELECT ${mode === 'write' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1, 518204))) queue, ${table(transaction, 'tf_authorization_lock')} authorization_lock WHERE authorization_lock.id = 1 FOR ${mode === 'write' ? 'UPDATE' : 'SHARE'} OF authorization_lock`,
    [transaction.schema],
  );

// Neither lock waits here, and a busy lock returns no row instead of an error that would abort the transaction.
const tryReadLock = (transaction: AuthorizationTransaction) =>
  transaction.client.query(
    `SELECT authorization_lock.id FROM (SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1, 518204)) AS taken) queue, ${table(transaction, 'tf_authorization_lock')} authorization_lock WHERE queue.taken AND authorization_lock.id = 1 FOR SHARE OF authorization_lock SKIP LOCKED`,
    [transaction.schema],
  );

function lockWaitFailed(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '55P03' || code === '40P01';
}

/**
 * Takes the lock inside a savepoint so a timed-out wait can be retried. Each attempt sends the savepoint, the lock, the
 * release and `follow` together in one round trip; Postgres runs them in order, so `follow` reads only once the lock is
 * held. A failed wait leaves the later statements failed as well, and rolling back to the savepoint clears them.
 */
async function retryLockWait<T extends { rowCount: number | null }, F = never>(
  transaction: AuthorizationTransaction,
  mode: 'read' | 'write',
  budgetMs: number,
  take: () => Promise<T>,
  follow?: () => Promise<F>,
): Promise<{ taken: T; followed: F | undefined }> {
  const started = performance.now();
  for (let retries = 0; ; retries++) {
    const [saved, taken, released, followed] = await pipelined(transaction.client, () => [
      transaction.client.query('SAVEPOINT tf_authorization_lock'),
      take(),
      transaction.client.query('RELEASE SAVEPOINT tf_authorization_lock'),
      ...(follow ? [follow()] : []),
    ]);
    if (saved?.status === 'rejected') throw saved.reason;
    if (taken?.status === 'fulfilled') {
      if (released?.status === 'rejected') throw released.reason;
      if (followed?.status === 'rejected') throw followed.reason;
      recordAuthorizationLock(mode, retries === 0 ? 'acquired' : 'retried', retries, performance.now() - started);
      return { taken: taken.value as T, followed: followed?.value as F | undefined };
    }
    const error: unknown = taken?.reason;
    if (!lockWaitFailed(error)) throw error;
    const now = performance.now();
    const backoff = Math.min(1_000, 50 * 2 ** retries) * (0.5 + Math.random());
    if (now - started + backoff >= budgetMs) {
      recordAuthorizationLock(mode, 'failed', retries, now - started);
      throw error;
    }
    const [rolledBack, cleared] = await pipelined(transaction.client, () => [
      transaction.client.query('ROLLBACK TO SAVEPOINT tf_authorization_lock'),
      transaction.client.query('RELEASE SAVEPOINT tf_authorization_lock'),
    ]);
    if (rolledBack?.status === 'rejected') throw rolledBack.reason;
    if (cleared?.status === 'rejected') throw cleared.reason;
    await delay(backoff);
  }
}

const readMember = (transaction: AuthorizationTransaction, userId: string) => () =>
  transaction.client.query(
    `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE user_id = $1 AND removed_at IS NULL`,
    [userId],
  );

export async function resolveHuman(transaction: AuthorizationTransaction, userId: string): Promise<HumanActor> {
  const known = `member:user:${userId}`;
  if (membersStable(transaction) && knownInTransaction(transaction.client, known)) {
    const member = await memoizeInTransaction(
      transaction.client,
      known,
      async (): Promise<z.infer<typeof membershipSchema>> => {
        throw new Error('unreachable');
      },
    );
    return { kind: 'human', userId: member.user_id, membershipId: member.id };
  }
  return humanFrom(transaction, await readMember(transaction, userId)(), userId);
}

/**
 * `lockAuthorization(transaction, mode)`, reading `userId`'s membership in the same round trip so a later `resolveHuman`
 * for them needs none. A non-member is not refused here: `resolveHuman` still refuses them where it did before.
 */
export async function lockAndPrefetchHuman(
  transaction: AuthorizationTransaction,
  userId: string,
  mode: 'read' | 'write' = 'read',
) {
  try {
    await lockAndResolveHuman(transaction, userId, mode);
  } catch (error) {
    if (!(error instanceof WorkspaceMembershipDenied)) throw error;
  }
}

function humanFrom(transaction: AuthorizationTransaction, result: { rows: unknown[] }, userId: string): HumanActor {
  const member = membershipSchema.optional().parse(result.rows[0]);
  if (!member) throw new WorkspaceMembershipDenied(userId);
  rememberMember(transaction, member);
  return { kind: 'human', userId: member.user_id, membershipId: member.id };
}

/**
 * `lockAuthorization(transaction, mode)` then `resolveHuman(transaction, userId)`. For a read, in one round trip when
 * the lock is free. Both statements go out together and Postgres runs them in order, so the member is still read after the lock is
 * held. A busy lock discards that read and waits as `lockAuthorization` does, then reads the member again.
 */
export async function lockAndResolveHuman(
  transaction: AuthorizationTransaction,
  userId: string,
  mode: 'read' | 'write' = 'read',
) {
  if (mode === 'write') {
    const { taken, followed } = await retryLockWait(
      transaction,
      'write',
      lockBudgetMs,
      waitForLock(transaction, 'write'),
      readMember(transaction, userId),
    );
    if (taken.rowCount !== 1) throw new AccessDenied();
    heldLock(transaction, 'write');
    return humanFrom(transaction, followed!, userId);
  }
  const connection = transaction.client as { pipeline?: boolean | undefined };
  const previous = connection.pipeline;
  // pg sends queries without waiting for earlier replies while this is on; it stays on until both replies arrive.
  connection.pipeline = true;
  const [lock, member] = await Promise.allSettled([tryReadLock(transaction), readMember(transaction, userId)()]);
  connection.pipeline = previous;
  if (lock.status === 'rejected') throw lock.reason;
  // A failed read aborted the transaction, so report it as resolveHuman would have after the wait.
  if (member.status === 'rejected') throw member.reason;
  if (lock.value.rowCount !== 1) {
    const { taken, followed } = await retryLockWait(
      transaction,
      'read',
      lockBudgetMs,
      waitForLock(transaction, 'read'),
      readMember(transaction, userId),
    );
    if (taken.rowCount !== 1) throw new AccessDenied();
    heldLock(transaction, 'read');
    return humanFrom(transaction, followed!, userId);
  }
  recordAuthorizationLock('read', 'acquired', 0, 0);
  heldLock(transaction, 'read');
  return humanFrom(transaction, member.value, userId);
}

/** `lockAuthorization(transaction, mode)`, then `resolveHuman` for a user id, in one round trip when the lock is free. */
export async function lockAndResolvePrincipal<A>(
  transaction: AuthorizationTransaction,
  principal: string | A,
  mode: 'read' | 'write' = 'read',
): Promise<HumanActor | A> {
  if (typeof principal === 'string') return lockAndResolveHuman(transaction, principal, mode);
  await lockAuthorization(transaction, mode);
  return principal;
}

export async function currentMember(transaction: AuthorizationTransaction, actor: HumanActor) {
  const read = async () => {
    const result = await transaction.client.query(
      `SELECT id, user_id, role FROM ${table(transaction, 'tf_memberships')} WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [actor.membershipId, actor.userId],
    );
    const member = membershipSchema.optional().parse(result.rows[0]);
    if (!member) throw new WorkspaceMembershipDenied(actor.userId);
    return member;
  };
  if (!membersStable(transaction)) return read();
  return { ...(await memoizeInTransaction(transaction.client, `member:${actor.membershipId}:${actor.userId}`, read)) };
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
  return relationInstalled(transaction.client, table(transaction, 'tf_table_person_grants'));
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
  // A grant on a team rather than a table covers every table that team owns, now or later.
  const owned = `EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_catalog')} cat
    JOIN ${table(transaction, 'tf_grants')} og ON og.asset_id = cat.owning_team_id
    JOIN ${table(transaction, 'tf_member_teams')} omt ON omt.team_id = og.team_id
    WHERE cat.id = ${assetId} AND omt.membership_id = ${membershipId}
      AND og.permission <> 'table.create' AND og.permission = ANY(${permissions}))`;
  const alternatives = [team, owned];
  if (await tablePersonGrantsInstalled(transaction))
    alternatives.push(
      `EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_person_grants')} pg
    WHERE pg.membership_id = ${membershipId} AND pg.asset_id = ${assetId} AND pg.permission = ANY(${permissions}))`,
      `EXISTS (SELECT 1 FROM ${table(transaction, 'tf_table_catalog')} pcat
    JOIN ${table(transaction, 'tf_table_person_grants')} opg ON opg.asset_id = pcat.owning_team_id
    WHERE pcat.id = ${assetId} AND opg.membership_id = ${membershipId}
      AND opg.permission <> 'table.create' AND opg.permission = ANY(${permissions}))`,
    );
  const installed = await relationInstalled(transaction.client, table(transaction, 'tf_system_tables'));
  if (installed)
    alternatives.push(`('table.row.read'=ANY(${permissions}) AND EXISTS (
    SELECT 1 FROM ${table(transaction, 'tf_system_tables')} directory
    JOIN ${table(transaction, 'tf_memberships')} reader ON reader.id=${membershipId} AND reader.removed_at IS NULL
    WHERE directory.kind='workspace-members' AND directory.table_id=${assetId}))`);
  // Every member works with the shared Tasks table's rows; its schema stays with its owning team.
  if (installed)
    alternatives.push(`(${permissions} && ARRAY['table.row.read','table.row.create','table.row.update','table.row.delete'] AND EXISTS (
    SELECT 1 FROM ${table(transaction, 'tf_system_tables')} shared
    JOIN ${table(transaction, 'tf_memberships')} worker ON worker.id=${membershipId} AND worker.removed_at IS NULL
    WHERE shared.kind='tasks' AND shared.table_id=${assetId}))`);
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
    const installed = await relationInstalled(
      transaction.client,
      table(transaction, 'tf_system_package_installations'),
    );
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
  switch (actor.kind) {
    case 'human':
      return canMemberAccess(transaction, actor, assetId, permission);
    case 'agent':
      return canAgentAccess(transaction, actor.runId, assetId, permission);
    case 'app':
      // Asset grants are table-wide; an app reads only through its own row- and field-bounded grants.
      return false;
    default:
      return unhandledActor(actor);
  }
}

async function canMemberAccess(
  transaction: AuthorizationTransaction,
  actor: HumanActor,
  assetId: string,
  permission: AssetPermission,
) {
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
  switch (actor.kind) {
    case 'human':
      await currentMember(transaction, actor);
      return;
    case 'agent':
      await agentAuthority(transaction, actor.runId);
      return;
    case 'app':
      throw new AccessDenied();
    default:
      unhandledActor(actor);
  }
}

/** The person whose access bounds a run: its delegating member. */
export async function agentRunOwner(transaction: AuthorizationTransaction, runId: string): Promise<HumanActor> {
  return (await agentAuthority(transaction, runId)).owner;
}

export async function queryHumanContext(
  transaction: AuthorizationTransaction,
  actor: Actor,
): Promise<HumanActor | null> {
  switch (actor.kind) {
    case 'human':
      await currentMember(transaction, actor);
      return actor;
    case 'agent':
      return (await agentAuthority(transaction, actor.runId)).owner;
    case 'app':
      return null;
    default:
      return unhandledActor(actor);
  }
}

export async function resolveActor(transaction: AuthorizationTransaction, principal: string | Actor): Promise<Actor> {
  if (typeof principal === 'string') return resolveHuman(transaction, principal);
  const actor = actorSchema.parse(principal);
  await requireCurrentActor(transaction, actor);
  return actor;
}

/** `lockAuthorization(transaction, mode)`, then `resolveActor`, in one round trip for a user id when the lock is free. */
export async function lockAndResolveActor(
  transaction: AuthorizationTransaction,
  principal: string | Actor,
  mode: 'read' | 'write' = 'read',
): Promise<Actor> {
  if (typeof principal === 'string') return lockAndResolveHuman(transaction, principal, mode);
  await lockAuthorization(transaction, mode);
  return resolveActor(transaction, principal);
}

export async function requirePersistedIssueCall(
  transaction: AuthorizationTransaction,
  actor: Actor,
  input: { requestId: string; integrationId: string; sourceId: string; issueNumber: number },
) {
  actor = actorSchema.parse(actor);
  switch (actor.kind) {
    case 'human':
      return;
    case 'agent':
      break;
    case 'app':
      throw new AccessDenied();
    default:
      unhandledActor(actor);
  }
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
  return canUseAgentEnrollment(transaction, owner, authority.agent_id, assetId, permission, authority.activation_id);
}

/** Enrollment and the person's current access; callers must also apply the agent's three scope bounds. */
export async function canUseAgentEnrollment(
  transaction: AuthorizationTransaction,
  owner: HumanActor,
  agentId: string,
  assetId: string,
  permission: AssetPermission,
  activationId?: string,
) {
  const target = grantTarget(permission);
  // Table permissions may also come from a policy on every table the owning team owns.
  const owned =
    target.name === 'tf_grants' && permission.startsWith('table.') && permission !== 'table.create'
      ? ` OR g.asset_id = (SELECT owning_team_id FROM ${table(transaction, 'tf_table_catalog')} WHERE id = $2)`
      : '';
  const grant = await transaction.client.query(
    `SELECT 1 FROM ${table(transaction, 'tf_agent_teams')} t JOIN ${table(transaction, target.name)} g ON g.team_id = t.team_id WHERE t.agent_id = $1 AND (g.${target.column} = $2${owned}) AND g.permission = $3 LIMIT 1`,
    [agentId, assetId, target.permission],
  );
  if (!grant.rowCount) {
    if (!permission.startsWith('table.') || !activationId) return false;
    const admin = await transaction.client.query(
      `SELECT 1 FROM ${table(transaction, 'tf_agent_teams')} enrolled
       JOIN ${table(transaction, 'tf_teams')} team ON team.id=enrolled.team_id AND team.name='_admin'
       JOIN ${table(transaction, 'tf_agent_activations')} activation ON activation.agent_id=enrolled.agent_id
       JOIN ${table(transaction, 'tf_memberships')} activator
         ON activator.id::text=to_jsonb(activation)->>'activated_by_membership_id'
       WHERE enrolled.agent_id=$1 AND activation.id=$2 AND activation.revoked_at IS NULL
         AND activator.role='admin' AND activator.removed_at IS NULL`,
      [agentId, activationId],
    );
    if (!admin.rowCount) return false;
  }
  return canAccessAsset(transaction, owner, assetId, permission);
}
