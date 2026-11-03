import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import {
  SecretError,
  TEMPORARY_LIFETIME_MS,
  createSecretInputSchema,
  grantSchema,
  destinationInputSchema,
  normalizeDestinations,
  parseValue,
  placementFits,
  placementSchema,
  originSchema,
  sameOrigin,
  secretKindSchema,
  type CreateSecretInput,
  type Destination,
  type DestinationInput,
  type Placement,
  type SecretEvent,
  type SecretGrant,
  type SecretKind,
  type SecretOrigin,
  type SecretStatus,
  type SecretSummary,
} from './contracts.ts';
import { secretCipher, type SecretKeyring } from './cipher.ts';

export type SecretsRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export type SecretsPrincipal = string | HumanActor;
export type SecretsOptions = {
  runtime: SecretsRuntime;
  keyring: SecretKeyring | (() => SecretKeyring);
  enabled?: boolean;
  now?: () => Date;
};
export type SecretTransaction = Pick<AuthorizationTransaction, 'client' | 'schema'>;

export const table = (tx: SecretTransaction, name: string) =>
  qualified(tx.schema, name === 'secrets' ? 'tf_secrets' : `tf_secret_${name}`);

const timestamp = z.union([z.date(), z.string()]).transform(value => new Date(value).toISOString());
const rowSchema = z.object({
  id: z.uuid(),
  owner_membership_id: z.uuid(),
  name: z.string(),
  kind: secretKindSchema,
  placement: placementSchema,
  placement_source: z.enum(['agent', 'member']),
  lifetime: z.enum(['saved', 'conversation']),
  origin: originSchema.nullable(),
  expires_at: timestamp.nullable(),
  version: z.number().int(),
  policy_version: z.number().int(),
  credential: z.unknown(),
  status: z.enum(['active', 'deleted']),
  created_at: timestamp,
  replaced_at: timestamp.nullable(),
  last_used_at: timestamp.nullable(),
  owner_removed: z.boolean(),
  expired: z.boolean(),
});
type Row = z.infer<typeof rowSchema>;
type Access = { owner: boolean; use: boolean; manage: boolean; status: SecretStatus };

const selectRow = (tx: SecretTransaction) => `SELECT s.*, m.removed_at IS NOT NULL AS owner_removed,
  (s.expires_at IS NOT NULL AND s.expires_at <= clock_timestamp()) AS expired
  FROM ${table(tx, 'secrets')} s JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id = s.owner_membership_id`;

// A grant matches a member directly, through any team they belong to, or through the workspace.
const grantMatch = (tx: SecretTransaction, secret: string, member: string, roles: string) =>
  `EXISTS (SELECT 1 FROM ${table(tx, 'grants')} g WHERE g.secret_id = ${secret} AND g.role IN (${roles})
    AND (g.grantee = 'workspace' OR g.membership_id = ${member}
      OR g.team_id IN (SELECT team_id FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE membership_id = ${member})))`;

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function statusOf(row: Row): SecretStatus {
  if (row.status === 'deleted') return 'deleted';
  if (row.expired) return 'expired';
  if (row.owner_removed) return 'suspended';
  return 'active';
}

export function createSecrets(options: SecretsOptions) {
  const cipher = secretCipher(options.keyring);
  const now = options.now ?? (() => new Date());

  function capabilities() {
    if (!options.enabled) return { enabled: false };
    try {
      cipher.check();
      return { enabled: true };
    } catch {
      return { enabled: false };
    }
  }
  function requireEnabled() {
    if (!capabilities().enabled) throw new SecretError('disabled');
  }

  async function transaction<T>(workspaceId: string, operation: (tx: AuthorizationTransaction) => Promise<T>) {
    return options.runtime.transaction(z.uuid().parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      return operation(tx);
    });
  }
  async function authorized<T>(
    workspaceId: string,
    principal: SecretsPrincipal,
    operation: (tx: AuthorizationTransaction, actor: HumanActor, role: 'admin' | 'member') => Promise<T>,
  ) {
    return transaction(workspaceId, async tx => {
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      const member = await currentMember(tx, actor);
      return operation(tx, actor, member.role);
    });
  }

  async function load(tx: SecretTransaction, id: string, lock: 'update' | 'share' | 'none' = 'update') {
    const suffix = lock === 'none' ? '' : ` FOR ${lock === 'update' ? 'UPDATE' : 'SHARE'} OF s`;
    const row = rowSchema
      .optional()
      .parse((await tx.client.query(`${selectRow(tx)} WHERE s.id = $1${suffix}`, [z.uuid().parse(id)])).rows[0]);
    if (!row) throw new AccessDenied();
    return row;
  }

  async function access(tx: SecretTransaction, membershipId: string, row: Row): Promise<Access> {
    const status = statusOf(row);
    const owner = row.owner_membership_id === membershipId;
    const { manage, use } = z
      .object({ manage: z.boolean(), use: z.boolean() })
      .parse(
        (
          await tx.client.query(
            `SELECT ${grantMatch(tx, '$1', '$2', `'manage'`)} AS manage, ${grantMatch(tx, '$1', '$2', `'use','manage'`)} AS use`,
            [row.id, membershipId],
          )
        ).rows[0],
      );
    const temporary = row.lifetime === 'conversation';
    return {
      owner,
      manage: owner || (!temporary && manage),
      use: status === 'active' && (owner || (!temporary && use)),
      status,
    };
  }

  // Only when nobody active may manage it can an admin delete a secret they cannot otherwise touch (P30).
  async function unmanaged(tx: SecretTransaction, row: Row) {
    if (!row.owner_removed) return false;
    const result = await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'grants')} g JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id = g.membership_id
       WHERE g.secret_id = $1 AND g.role = 'manage' AND m.removed_at IS NULL LIMIT 1`,
      [row.id],
    );
    return result.rowCount === 0;
  }

  async function destinations(tx: SecretTransaction, ids: string[]) {
    const map = new Map<string, Destination[]>(ids.map(id => [id, []]));
    if (!ids.length) return map;
    const rows = z
      .array(z.object({ secret_id: z.uuid(), kind: z.enum(['host', 'endpoint']), value: z.string() }))
      .parse(
        (
          await tx.client.query(
            `SELECT secret_id, kind, value FROM ${table(tx, 'destinations')} WHERE secret_id = ANY($1::uuid[]) ORDER BY kind, value`,
            [ids],
          )
        ).rows,
      );
    for (const row of rows) map.get(row.secret_id)!.push({ kind: row.kind, value: row.value });
    return map;
  }

  async function grants(tx: SecretTransaction, ids: string[]) {
    const map = new Map<string, SecretGrant[]>(ids.map(id => [id, []]));
    if (!ids.length) return map;
    const rows = z
      .array(
        z.object({
          secret_id: z.uuid(),
          grantee: z.string(),
          membership_id: z.uuid().nullable(),
          team_id: z.uuid().nullable(),
          role: z.enum(['use', 'manage']),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT secret_id, grantee, membership_id, team_id, role FROM ${table(tx, 'grants')}
             WHERE secret_id = ANY($1::uuid[]) ORDER BY grantee`,
            [ids],
          )
        ).rows,
      );
    for (const row of rows)
      map.get(row.secret_id)!.push({
        grantee: row.membership_id
          ? { kind: 'member', membershipId: row.membership_id }
          : row.team_id
            ? { kind: 'team', teamId: row.team_id }
            : { kind: 'workspace' },
        role: row.role,
      });
    return map;
  }

  async function summarize(tx: SecretTransaction, membershipId: string, rows: Row[]): Promise<SecretSummary[]> {
    const ids = rows.map(row => row.id);
    const [destinationMap, grantMap] = await Promise.all([destinations(tx, ids), grants(tx, ids)]);
    const result: SecretSummary[] = [];
    for (const row of rows) {
      const rights = await access(tx, membershipId, row);
      result.push({
        id: row.id,
        name: row.name,
        kind: row.kind,
        placement: row.placement,
        placementSource: row.placement_source,
        lifetime: row.lifetime,
        origin: row.origin,
        destinations: destinationMap.get(row.id)!,
        // Only those who may manage a secret see whom it is shared with.
        grants: rights.manage ? grantMap.get(row.id)! : [],
        ownerMembershipId: row.owner_membership_id,
        status: rights.status,
        version: row.version,
        policyVersion: row.policy_version,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        replacedAt: row.replaced_at,
        lastUsedAt: row.last_used_at,
        canManage: rights.manage && rights.status !== 'deleted',
      });
    }
    return result;
  }

  async function event(
    tx: SecretTransaction,
    secretId: string,
    actorMembershipId: string | null,
    operation: string,
    details: Record<string, unknown> = {},
  ) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'events')} (id, secret_id, actor_membership_id, operation, details) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), secretId, actorMembershipId, operation, JSON.stringify(details)],
    );
  }

  /** Replays an earlier result for the same request ID. Digests never include values. */
  async function command<T>(
    tx: SecretTransaction,
    actor: HumanActor,
    requestId: string,
    kind: string,
    input: unknown,
    schema: z.ZodType<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    z.uuid().parse(requestId);
    const hash = digest([kind, input]);
    const old = z
      .object({ kind: z.string(), digest: z.string(), result: z.unknown() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT kind, digest, result FROM ${table(tx, 'commands')} WHERE membership_id = $1 AND request_id = $2`,
            [actor.membershipId, requestId],
          )
        ).rows[0],
      );
    if (old) {
      if (old.kind !== kind || old.digest !== hash) throw new SecretError('conflict');
      return schema.parse(old.result);
    }
    const result = await operation();
    await tx.client.query(
      `INSERT INTO ${table(tx, 'commands')} (membership_id, request_id, kind, digest, result) VALUES ($1,$2,$3,$4,$5)`,
      [actor.membershipId, requestId, kind, hash, JSON.stringify(result)],
    );
    return result;
  }

  function futureExpiry(value: string | null | undefined) {
    if (value == null) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getTime() <= now().getTime()) throw new SecretError('invalid-input');
    return date.toISOString();
  }

  async function validateGrants(tx: SecretTransaction, owner: string, input: readonly SecretGrant[]) {
    const unique = new Map<string, { grant: SecretGrant; membershipId: string | null; teamId: string | null }>();
    for (const raw of input) {
      const grant = grantSchema.parse(raw);
      const { grantee } = grant;
      // Managing is named per member (P23); teams and the workspace may only use.
      if (grant.role === 'manage' && grantee.kind !== 'member') throw new SecretError('invalid-input');
      if (grantee.kind === 'member') {
        if (grantee.membershipId === owner) continue;
        const found = await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id = $1 AND removed_at IS NULL`,
          [grantee.membershipId],
        );
        if (!found.rowCount) throw new SecretError('invalid-input');
      }
      if (grantee.kind === 'team') {
        const found = await tx.client.query(`SELECT 1 FROM ${qualified(tx.schema, 'tf_teams')} WHERE id = $1`, [
          grantee.teamId,
        ]);
        if (!found.rowCount) throw new SecretError('invalid-input');
      }
      const key =
        grantee.kind === 'member'
          ? `member:${grantee.membershipId}`
          : grantee.kind === 'team'
            ? `team:${grantee.teamId}`
            : 'workspace';
      const previous = unique.get(key);
      if (previous?.grant.role === 'manage') continue;
      unique.set(key, {
        grant,
        membershipId: grantee.kind === 'member' ? grantee.membershipId : null,
        teamId: grantee.kind === 'team' ? grantee.teamId : null,
      });
    }
    return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  async function writeGrants(
    tx: SecretTransaction,
    secretId: string,
    actorMembershipId: string,
    entries: Awaited<ReturnType<typeof validateGrants>>,
  ) {
    await tx.client.query(`DELETE FROM ${table(tx, 'grants')} WHERE secret_id = $1`, [secretId]);
    for (const [key, entry] of entries)
      await tx.client.query(
        `INSERT INTO ${table(tx, 'grants')} (secret_id, grantee, membership_id, team_id, role, granted_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [secretId, key, entry.membershipId, entry.teamId, entry.grant.role, actorMembershipId],
      );
  }

  async function writeDestinations(tx: SecretTransaction, secretId: string, list: readonly Destination[]) {
    await tx.client.query(`DELETE FROM ${table(tx, 'destinations')} WHERE secret_id = $1`, [secretId]);
    for (const destination of list)
      await tx.client.query(`INSERT INTO ${table(tx, 'destinations')} (secret_id, kind, value) VALUES ($1,$2,$3)`, [
        secretId,
        destination.kind,
        destination.value,
      ]);
  }

  async function one(tx: SecretTransaction, actor: HumanActor, id: string) {
    const [summary] = await summarize(tx, actor.membershipId, [await load(tx, id, 'none')]);
    return summary!;
  }

  /** Locks a secret for a change that needs `manage`, refusing deleted and expired secrets. */
  async function managed(tx: SecretTransaction, actor: HumanActor, id: string) {
    const row = await load(tx, id);
    const rights = await access(tx, actor.membershipId, row);
    if (!rights.manage && !rights.use) throw new AccessDenied();
    if (!rights.manage) throw new AccessDenied();
    if (rights.status === 'deleted') throw new SecretError('unavailable');
    if (rights.status === 'expired') throw new SecretError('expired');
    return { row, rights };
  }

  function checkVersion(actual: number, expected: number) {
    if (actual !== expected) throw new SecretError('conflict');
  }

  const summarySchema = z.custom<SecretSummary>(value => !!value && typeof value === 'object');

  /**
   * Stores a new secret. Used by the settings form and, with a `conversation` lifetime, by a submitted
   * request; the caller checks that the origin belongs to the actor.
   */
  async function insert(tx: SecretTransaction, workspaceId: string, actor: HumanActor, raw: CreateSecretInput) {
    const input = createSecretInputSchema.parse(raw);
    if (!placementFits(input.kind, input.placement)) throw new SecretError('invalid-input');
    const value = parseValue(input.kind, input.value);
    const list = normalizeDestinations(input.destinations);
    const origin = input.lifetime.kind === 'conversation' ? input.lifetime.origin : null;
    const temporary = origin !== null;
    if (temporary && input.grants.length) throw new SecretError('invalid-input');
    const expiresAt =
      futureExpiry(input.expiresAt) ??
      (temporary ? new Date(now().getTime() + TEMPORARY_LIFETIME_MS).toISOString() : null);
    const entries = await validateGrants(tx, actor.membershipId, input.grants);
    const id = randomUUID();
    const credential = cipher.encrypt({ workspaceId, secretId: id, version: 1, placement: input.placement }, value);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'secrets')} (id, owner_membership_id, name, kind, placement, placement_source, lifetime,
         origin, expires_at, credential, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')`,
      [
        id,
        actor.membershipId,
        input.name,
        input.kind,
        JSON.stringify(input.placement),
        input.placementSource,
        input.lifetime.kind,
        origin ? JSON.stringify(origin) : null,
        expiresAt,
        JSON.stringify(credential),
      ],
    );
    await writeDestinations(tx, id, list);
    await writeGrants(tx, id, actor.membershipId, entries);
    await event(tx, id, actor.membershipId, 'created', {
      placement: input.placement,
      placementSource: input.placementSource,
      lifetime: input.lifetime.kind,
      destinations: list,
      expiresAt,
      grants: entries.map(([key, entry]) => ({ grantee: key, role: entry.grant.role })),
    });
    return id;
  }

  async function remove(tx: SecretTransaction, row: Row, actorMembershipId: string | null, operation: string) {
    await tx.client.query(
      `UPDATE ${table(tx, 'secrets')} SET status = 'deleted', credential = NULL, version = version + 1,
         deleted_at = clock_timestamp() WHERE id = $1 AND status = 'active'`,
      [row.id],
    );
    await tx.client.query(`DELETE FROM ${table(tx, 'grants')} WHERE secret_id = $1`, [row.id]);
    await event(tx, row.id, actorMembershipId, operation);
  }

  /** Deletes the temporary secrets of a chat or task run, in the caller's transaction (P46). */
  async function deleteOrigin(tx: SecretTransaction, origin: SecretOrigin) {
    const parsed = originSchema.parse(origin);
    const rows = z
      .array(rowSchema)
      .parse(
        (
          await tx.client.query(
            `${selectRow(tx)} WHERE s.status = 'active' AND s.lifetime = 'conversation' AND s.origin @> $1::jsonb FOR UPDATE OF s`,
            [JSON.stringify(parsed)],
          )
        ).rows,
      );
    const matching = rows.filter(row => row.origin && sameOrigin(row.origin, parsed));
    for (const row of matching) await remove(tx, row, null, 'origin-ended');
    return matching.length;
  }

  return {
    capabilities,
    transaction,
    deleteOrigin,

    async create(workspaceId: string, principal: SecretsPrincipal, input: CreateSecretInput) {
      requireEnabled();
      return authorized(workspaceId, principal, async (tx, actor) => {
        const { value: _value, ...shape } = createSecretInputSchema.parse(input);
        return command(tx, actor, shape.requestId, 'create', shape, summarySchema, async () =>
          one(tx, actor, await insert(tx, workspaceId, actor, input)),
        );
      });
    },

    /** Secrets the member can use or manage, and, for an admin, suspended secrets nobody else can manage. */
    async list(workspaceId: string, principal: SecretsPrincipal) {
      return authorized(workspaceId, principal, async (tx, actor, role) => {
        const rows = z.array(rowSchema).parse(
          (
            await tx.client.query(
              `${selectRow(tx)} WHERE s.status = 'active' AND (s.owner_membership_id = $1
                   OR (s.lifetime = 'saved' AND ${grantMatch(tx, 's.id', '$1', `'use','manage'`)})
                   OR ($2 AND m.removed_at IS NOT NULL))
                 ORDER BY s.lifetime DESC, lower(s.name), s.created_at`,
              [actor.membershipId, role === 'admin'],
            )
          ).rows,
        );
        const visible: Row[] = [];
        for (const row of rows) {
          const rights = await access(tx, actor.membershipId, row);
          if (rights.manage || rights.use || rights.owner || (role === 'admin' && (await unmanaged(tx, row))))
            visible.push(row);
        }
        return summarize(tx, actor.membershipId, visible);
      });
    },

    async get(workspaceId: string, principal: SecretsPrincipal, id: string) {
      return authorized(workspaceId, principal, async (tx, actor, role) => {
        const row = await load(tx, id, 'none');
        const rights = await access(tx, actor.membershipId, row);
        const visible = rights.owner || rights.manage || rights.use;
        if (!visible && !(role === 'admin' && row.status === 'active' && (await unmanaged(tx, row))))
          throw new AccessDenied();
        return (await summarize(tx, actor.membershipId, [row]))[0]!;
      });
    },

    async history(workspaceId: string, principal: SecretsPrincipal, id: string): Promise<SecretEvent[]> {
      return authorized(workspaceId, principal, async (tx, actor) => {
        const row = await load(tx, id, 'none');
        if (!(await access(tx, actor.membershipId, row)).manage) throw new AccessDenied();
        return z
          .array(
            z
              .object({
                operation: z.string(),
                actor_membership_id: z.uuid().nullable(),
                details: z.record(z.string(), z.unknown()),
                created_at: timestamp,
              })
              .transform(event => ({
                operation: event.operation,
                actorMembershipId: event.actor_membership_id,
                details: event.details,
                createdAt: event.created_at,
              })),
          )
          .parse(
            (
              await tx.client.query(
                `SELECT operation, actor_membership_id, details, created_at FROM ${table(tx, 'events')}
                 WHERE secret_id = $1 ORDER BY created_at, id`,
                [row.id],
              )
            ).rows,
          );
      });
    },

    async replace(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      input: { requestId: string; expectedVersion: number; value: unknown },
    ) {
      requireEnabled();
      return authorized(workspaceId, principal, async (tx, actor) =>
        command(
          tx,
          actor,
          input.requestId,
          'replace',
          { id, expectedVersion: input.expectedVersion },
          summarySchema,
          async () => {
            const { row, rights } = await managed(tx, actor, id);
            if (rights.status === 'suspended') throw new SecretError('unavailable');
            checkVersion(row.version, input.expectedVersion);
            await reencrypt(tx, workspaceId, row, input.value, row.owner_membership_id);
            await event(tx, row.id, actor.membershipId, 'replaced', { version: row.version + 1 });
            return one(tx, actor, row.id);
          },
        ),
      );
    },

    /** A manager of a suspended secret takes it over by entering a new value (P30). */
    async takeOwnership(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      input: { requestId: string; expectedVersion: number; value: unknown },
    ) {
      requireEnabled();
      return authorized(workspaceId, principal, async (tx, actor) =>
        command(
          tx,
          actor,
          input.requestId,
          'take-ownership',
          { id, expectedVersion: input.expectedVersion },
          summarySchema,
          async () => {
            const { row, rights } = await managed(tx, actor, id);
            if (rights.status !== 'suspended') throw new SecretError('conflict');
            checkVersion(row.version, input.expectedVersion);
            await reencrypt(tx, workspaceId, row, input.value, actor.membershipId);
            await tx.client.query(`DELETE FROM ${table(tx, 'grants')} WHERE secret_id = $1 AND membership_id = $2`, [
              row.id,
              actor.membershipId,
            ]);
            await event(tx, row.id, actor.membershipId, 'ownership-taken', {
              previousOwnerMembershipId: row.owner_membership_id,
              version: row.version + 1,
            });
            return one(tx, actor, row.id);
          },
        ),
      );
    },

    async setDestinations(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      input: { requestId: string; expectedPolicyVersion: number; destinations: DestinationInput[] },
    ) {
      return authorized(workspaceId, principal, async (tx, actor) =>
        command(tx, actor, input.requestId, 'destinations', { id, ...input }, summarySchema, async () => {
          const { row } = await managed(tx, actor, id);
          checkVersion(row.policy_version, input.expectedPolicyVersion);
          const list = normalizeDestinations(z.array(destinationInputSchema).parse(input.destinations));
          await writeDestinations(tx, row.id, list);
          await bumpPolicy(tx, row.id);
          await event(tx, row.id, actor.membershipId, 'destinations-changed', { destinations: list });
          return one(tx, actor, row.id);
        }),
      );
    },

    async setGrants(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      input: { requestId: string; expectedPolicyVersion: number; grants: SecretGrant[] },
    ) {
      return authorized(workspaceId, principal, async (tx, actor) =>
        command(tx, actor, input.requestId, 'grants', { id, ...input }, summarySchema, async () => {
          const { row, rights } = await managed(tx, actor, id);
          if (row.lifetime === 'conversation') throw new SecretError('invalid-input');
          checkVersion(row.policy_version, input.expectedPolicyVersion);
          const entries = await validateGrants(tx, row.owner_membership_id, input.grants);
          const managers = (list: Iterable<string>) => [...list].sort().join(',');
          const before = (await grants(tx, [row.id]))
            .get(row.id)!
            .flatMap(grant =>
              grant.role === 'manage' && grant.grantee.kind === 'member' ? [grant.grantee.membershipId] : [],
            );
          const after = entries.flatMap(([, entry]) =>
            entry.grant.role === 'manage' && entry.membershipId ? [entry.membershipId] : [],
          );
          // Only the owner names managers; another manager may share for use or remove only themselves.
          if (!rights.owner && managers(before) !== managers(after)) {
            const removedSelfOnly =
              managers(before.filter(member => member !== actor.membershipId)) === managers(after);
            if (!removedSelfOnly) throw new AccessDenied();
          }
          await writeGrants(tx, row.id, actor.membershipId, entries);
          await bumpPolicy(tx, row.id);
          await event(tx, row.id, actor.membershipId, 'grants-changed', {
            grants: entries.map(([key, entry]) => ({ grantee: key, role: entry.grant.role })),
          });
          return one(tx, actor, row.id);
        }),
      );
    },

    /** Sets or clears the expiry. A temporary secret's expiry can move but never be cleared (P46, P47). */
    async setExpiry(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      input: { requestId: string; expectedPolicyVersion: number; expiresAt: string | null },
    ) {
      return authorized(workspaceId, principal, async (tx, actor) =>
        command(tx, actor, input.requestId, 'expiry', { id, ...input }, summarySchema, async () => {
          const { row } = await managed(tx, actor, id);
          checkVersion(row.policy_version, input.expectedPolicyVersion);
          const expiresAt = futureExpiry(input.expiresAt);
          if (row.lifetime === 'conversation' && !expiresAt) throw new SecretError('invalid-input');
          await tx.client.query(`UPDATE ${table(tx, 'secrets')} SET expires_at = $2 WHERE id = $1`, [
            row.id,
            expiresAt,
          ]);
          await bumpPolicy(tx, row.id);
          await event(tx, row.id, actor.membershipId, 'expiry-changed', { expiresAt });
          return one(tx, actor, row.id);
        }),
      );
    },

    /** Turns a temporary secret into a saved one without re-entering the value (P48). */
    async save(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      input: {
        requestId: string;
        expectedPolicyVersion: number;
        name?: string | undefined;
        expiresAt?: string | null | undefined;
      },
    ) {
      return authorized(workspaceId, principal, async (tx, actor) =>
        command(tx, actor, input.requestId, 'save', { id, ...input }, summarySchema, async () => {
          const { row, rights } = await managed(tx, actor, id);
          if (!rights.owner || row.lifetime !== 'conversation') throw new SecretError('invalid-input');
          checkVersion(row.policy_version, input.expectedPolicyVersion);
          const expiresAt = futureExpiry(input.expiresAt);
          const name = input.name === undefined ? row.name : z.string().trim().min(1).max(80).parse(input.name);
          await tx.client.query(
            `UPDATE ${table(tx, 'secrets')} SET lifetime = 'saved', origin = NULL, expires_at = $2, name = $3 WHERE id = $1`,
            [row.id, expiresAt, name],
          );
          await bumpPolicy(tx, row.id);
          await event(tx, row.id, actor.membershipId, 'saved', { expiresAt });
          return one(tx, actor, row.id);
        }),
      );
    },

    async delete(
      workspaceId: string,
      principal: SecretsPrincipal,
      id: string,
      input: { requestId: string; expectedVersion: number },
    ) {
      return authorized(workspaceId, principal, async (tx, actor, role) =>
        command(
          tx,
          actor,
          input.requestId,
          'delete',
          { id, ...input },
          z.object({ deleted: z.literal(true) }),
          async () => {
            const row = await load(tx, id);
            const rights = await access(tx, actor.membershipId, row);
            const admin = role === 'admin' && (await unmanaged(tx, row));
            if (!rights.manage && !admin) throw new AccessDenied();
            if (row.status === 'deleted') throw new SecretError('unavailable');
            checkVersion(row.version, input.expectedVersion);
            await remove(tx, row, actor.membershipId, 'deleted');
            return { deleted: true as const };
          },
        ),
      );
    },

    /** Deletes every secret past its expiry. Run by the worker sweep. */
    async sweepExpired(workspaceId: string) {
      return transaction(workspaceId, async tx => {
        const rows = z.array(rowSchema).parse(
          (
            await tx.client.query(
              `${selectRow(tx)} WHERE s.status = 'active' AND s.expires_at <= clock_timestamp()
                 ORDER BY s.expires_at LIMIT 500 FOR UPDATE OF s SKIP LOCKED`,
            )
          ).rows,
        );
        for (const row of rows) await remove(tx, row, null, 'expired');
        return rows.length;
      });
    },

    /** Internal pieces for `send.ts` and the request flow; not for the API. */
    internal: { load, access, event, cipher, insert, command, authorized },
  };

  async function bumpPolicy(tx: SecretTransaction, id: string) {
    await tx.client.query(`UPDATE ${table(tx, 'secrets')} SET policy_version = policy_version + 1 WHERE id = $1`, [id]);
  }

  async function reencrypt(tx: SecretTransaction, workspaceId: string, row: Row, raw: unknown, owner: string) {
    const value = parseValue(row.kind, raw);
    const version = row.version + 1;
    const credential = cipher.encrypt({ workspaceId, secretId: row.id, version, placement: row.placement }, value);
    const updated = await tx.client.query(
      `UPDATE ${table(tx, 'secrets')} SET credential = $3, version = $2, owner_membership_id = $4,
         replaced_at = clock_timestamp() WHERE id = $1 AND version = $5 AND status = 'active'`,
      [row.id, version, JSON.stringify(credential), owner, row.version],
    );
    if (updated.rowCount !== 1) throw new SecretError('conflict');
  }
}
export type Secrets = ReturnType<typeof createSecrets>;
export type { Placement, SecretKind };
