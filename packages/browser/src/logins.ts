import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { compactEnvelopeSchema, decrypt, encryptCompact, type Keyring } from '@tulipfarm/keyring';
import { grantSchema, type SecretGrant } from '@tulipfarm/secrets/contracts';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { browserSiteSchema, browserSiteStateSchema, siteIncludes, type BrowserSiteState } from './contracts.ts';
import {
  BrowserLoginError,
  browserLoginNameSchema,
  saveBrowserLoginSchema,
  shareBrowserLoginSchema,
  type BrowserLoginStatus,
  type BrowserLoginSummary,
  type SaveBrowserLogin,
} from './login-contracts.ts';

export * from './login-contracts.ts';

/** The largest saved state, serialized. Larger sites keep too much in storage to be worth saving. */
export const MAX_BROWSER_LOGIN_BYTES = 2 * 1024 * 1024;

/** The `INTEGRATION_CREDENTIAL` keyring in the shape the apps load: hex keys by ID. */
export const browserLoginKeyringSchema = z.strictObject({
  activeKeyId: z.string().min(1),
  keys: z.record(z.string(), z.string().regex(/^[a-fA-F0-9]{64}$/)),
});
export type BrowserLoginKeyring = z.infer<typeof browserLoginKeyringSchema>;

export type BrowserLoginsRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export type BrowserLoginsPrincipal = string | HumanActor;
export type BrowserLoginsOptions = {
  runtime: BrowserLoginsRuntime;
  keyring: BrowserLoginKeyring | (() => BrowserLoginKeyring);
};

/** A login's state, decrypted for loading into a session. */
export type BrowserLoginState = { id: string; site: string; version: number; state: BrowserSiteState };

/** What a session holds for a login at the end of a turn. */
export const browserLoginSaveBackSchema = z.strictObject({
  id: z.uuid(),
  signedOut: z.boolean(),
  state: browserSiteStateSchema.optional(),
});
export type BrowserLoginSaveBack = z.infer<typeof browserLoginSaveBackSchema>;

type Tx = Pick<AuthorizationTransaction, 'client' | 'schema'>;
const table = (tx: Tx, name: string) => qualified(tx.schema, `tf_browser_login${name}`);

const timestamp = z.union([z.date(), z.string()]).transform(value => new Date(value).toISOString());
const rowSchema = z.object({
  id: z.uuid(),
  owner_membership_id: z.uuid(),
  name: z.string(),
  site: z.string(),
  state: z.unknown(),
  version: z.number().int(),
  needs_sign_in: z.boolean(),
  status: z.enum(['active', 'deleted']),
  created_at: timestamp,
  saved_at: timestamp,
  last_used_at: timestamp.nullable(),
  owner_removed: z.boolean(),
});
type Row = z.infer<typeof rowSchema>;
type Access = { owner: boolean; use: boolean; manage: boolean; status: BrowserLoginStatus | 'deleted' };

const selectRow = (tx: Tx) => `SELECT l.*, m.removed_at IS NOT NULL AS owner_removed
  FROM ${table(tx, 's')} l JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id = l.owner_membership_id`;

// A grant matches a member directly, through any team they belong to, or through the workspace.
const grantMatch = (tx: Tx, login: string, member: string, roles: string) =>
  `EXISTS (SELECT 1 FROM ${table(tx, '_grants')} g WHERE g.login_id = ${login} AND g.role IN (${roles})
    AND (g.grantee = 'workspace' OR g.membership_id = ${member}
      OR g.team_id IN (SELECT team_id FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE membership_id = ${member})))`;

function statusOf(row: Row): Access['status'] {
  if (row.status === 'deleted') return 'deleted';
  if (row.owner_removed) return 'suspended';
  return row.needs_sign_in ? 'needs-sign-in' : 'active';
}

// Binding the login and version means a stored state cannot be moved to another login or rolled back unnoticed.
const associatedData = (workspaceId: string, loginId: string, version: number) =>
  Buffer.from(JSON.stringify(['browser-login-v1', workspaceId, loginId, version]));

function loginCipher(input: BrowserLoginsOptions['keyring']) {
  let ring: Keyring | undefined;
  function keys(): Keyring {
    if (ring) return ring;
    try {
      const parsed = browserLoginKeyringSchema.parse(typeof input === 'function' ? input() : input);
      const key = parsed.keys[parsed.activeKeyId];
      if (!key) throw new Error();
      ring = {
        keyId: parsed.activeKeyId,
        key: Buffer.from(key, 'hex'),
        previous: new Map(
          Object.entries(parsed.keys)
            .filter(([id]) => id !== parsed.activeKeyId)
            .map(([id, hex]) => [id, Buffer.from(hex, 'hex')]),
        ),
      };
      return ring;
    } catch {
      throw new BrowserLoginError('disabled');
    }
  }
  return {
    check: () => void keys(),
    encrypt(workspaceId: string, loginId: string, version: number, state: BrowserSiteState) {
      const serialized = JSON.stringify(browserSiteStateSchema.parse(state));
      if (Buffer.byteLength(serialized) > MAX_BROWSER_LOGIN_BYTES) throw new BrowserLoginError('too-large');
      return encryptCompact(serialized, keys(), associatedData(workspaceId, loginId, version));
    },
    decrypt(workspaceId: string, row: Row): BrowserSiteState {
      const ring = keys();
      try {
        return browserSiteStateSchema.parse(
          JSON.parse(
            decrypt(compactEnvelopeSchema.parse(row.state), ring, associatedData(workspaceId, row.id, row.version)),
          ),
        );
      } catch {
        throw new BrowserLoginError('unavailable');
      }
    },
  };
}

export function createBrowserLogins(options: BrowserLoginsOptions) {
  const cipher = loginCipher(options.keyring);

  function capabilities() {
    try {
      cipher.check();
      return { enabled: true };
    } catch {
      return { enabled: false };
    }
  }
  function requireEnabled() {
    if (!capabilities().enabled) throw new BrowserLoginError('disabled');
  }

  async function authorized<T>(
    workspaceId: string,
    principal: BrowserLoginsPrincipal,
    mode: 'read' | 'write',
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return options.runtime.transaction(z.uuid().parse(workspaceId), commonCompatibility, async tx => {
      // Writes hold the lock exclusively, so access can't change while a login's owner or grants change.
      await lockAuthorization(tx, mode);
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }

  async function load(tx: Tx, id: string, lock = true) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new AccessDenied();
    const row = rowSchema
      .optional()
      .parse(
        (await tx.client.query(`${selectRow(tx)} WHERE l.id = $1${lock ? ' FOR UPDATE OF l' : ''}`, [parsed.data]))
          .rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }

  async function access(tx: Tx, membershipId: string, row: Row): Promise<Access> {
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
    const live = status !== 'deleted';
    return {
      owner,
      manage: live && (owner || manage),
      use: live && status !== 'suspended' && (owner || use),
      status,
    };
  }

  async function grants(tx: Tx, ids: string[]) {
    const map = new Map<string, SecretGrant[]>(ids.map(id => [id, []]));
    if (!ids.length) return map;
    const rows = z
      .array(
        z.object({
          login_id: z.uuid(),
          membership_id: z.uuid().nullable(),
          team_id: z.uuid().nullable(),
          role: z.enum(['use', 'manage']),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT login_id, membership_id, team_id, role FROM ${table(tx, '_grants')}
             WHERE login_id = ANY($1::uuid[]) ORDER BY grantee`,
            [ids],
          )
        ).rows,
      );
    for (const row of rows)
      map.get(row.login_id)!.push({
        grantee: row.membership_id
          ? { kind: 'member', membershipId: row.membership_id }
          : row.team_id
            ? { kind: 'team', teamId: row.team_id }
            : { kind: 'workspace' },
        role: row.role,
      });
    return map;
  }

  async function summarize(tx: Tx, membershipId: string, rows: Row[]): Promise<BrowserLoginSummary[]> {
    const grantMap = await grants(
      tx,
      rows.map(row => row.id),
    );
    const result: BrowserLoginSummary[] = [];
    for (const row of rows) {
      const rights = await access(tx, membershipId, row);
      if (rights.status === 'deleted' || (!rights.use && !rights.manage)) continue;
      result.push({
        id: row.id,
        name: row.name,
        site: row.site,
        ownerMembershipId: row.owner_membership_id,
        status: rights.status,
        // Only those who may manage a login see whom it is shared with.
        grants: rights.manage ? grantMap.get(row.id)! : [],
        canManage: rights.manage,
        canUse: rights.use,
        createdAt: row.created_at,
        savedAt: row.saved_at,
        lastUsedAt: row.last_used_at,
      });
    }
    return result;
  }

  async function event(tx: Tx, loginId: string, actor: string | null, operation: string, details = {}) {
    await tx.client.query(
      `INSERT INTO ${table(tx, '_events')} (id, login_id, actor_membership_id, operation, details) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), loginId, actor, operation, JSON.stringify(details)],
    );
  }

  async function managed(tx: Tx, actor: HumanActor, id: string) {
    const row = await load(tx, id);
    const rights = await access(tx, actor.membershipId, row);
    if (!rights.manage) throw new AccessDenied();
    return row;
  }

  async function one(tx: Tx, actor: HumanActor, id: string) {
    const [summary] = await summarize(tx, actor.membershipId, [await load(tx, id, false)]);
    if (!summary) throw new AccessDenied();
    return summary;
  }

  async function validateGrants(tx: Tx, owner: string, input: readonly SecretGrant[]) {
    const unique = new Map<string, { role: 'use' | 'manage'; membershipId: string | null; teamId: string | null }>();
    for (const raw of input) {
      const { grantee, role } = grantSchema.parse(raw);
      // Managing is named per member; teams and the workspace may only use.
      if (role === 'manage' && grantee.kind !== 'member') throw new BrowserLoginError('invalid-input');
      if (grantee.kind === 'member') {
        if (grantee.membershipId === owner) continue;
        const found = await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id = $1 AND removed_at IS NULL`,
          [grantee.membershipId],
        );
        if (!found.rowCount) throw new BrowserLoginError('invalid-input');
      }
      if (grantee.kind === 'team') {
        const found = await tx.client.query(`SELECT 1 FROM ${qualified(tx.schema, 'tf_teams')} WHERE id = $1`, [
          grantee.teamId,
        ]);
        if (!found.rowCount) throw new BrowserLoginError('invalid-input');
      }
      const key =
        grantee.kind === 'member'
          ? `member:${grantee.membershipId}`
          : grantee.kind === 'team'
            ? `team:${grantee.teamId}`
            : 'workspace';
      if (unique.get(key)?.role === 'manage') continue;
      unique.set(key, {
        role,
        membershipId: grantee.kind === 'member' ? grantee.membershipId : null,
        teamId: grantee.kind === 'team' ? grantee.teamId : null,
      });
    }
    return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new BrowserLoginError('invalid-input');
    return parsed.data;
  }

  return {
    capabilities,

    /** Logins the member can use or manage, optionally only those for a site. */
    async list(workspaceId: string, principal: BrowserLoginsPrincipal, filter: { site?: string } = {}) {
      const site = filter.site === undefined ? undefined : parse(browserSiteSchema, filter.site);
      return authorized(workspaceId, principal, 'read', async (tx, actor) => {
        const rows = z.array(rowSchema).parse(
          (
            await tx.client.query(
              `${selectRow(tx)} WHERE l.status = 'active' AND (l.owner_membership_id = $1
                 OR ${grantMatch(tx, 'l.id', '$1', `'use','manage'`)})
               ORDER BY lower(l.name), l.created_at`,
              [actor.membershipId],
            )
          ).rows,
        );
        return summarize(
          tx,
          actor.membershipId,
          site === undefined ? rows : rows.filter(row => siteIncludes(row.site, site)),
        );
      });
    },

    /** Saves a session's state for a site as a new login the member owns. */
    async save(
      workspaceId: string,
      principal: BrowserLoginsPrincipal,
      input: SaveBrowserLogin,
      state: BrowserSiteState,
    ) {
      requireEnabled();
      const { name, site } = parse(saveBrowserLoginSchema, input);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        const id = randomUUID();
        const envelope = cipher.encrypt(workspaceId, id, 1, state);
        await tx.client.query(
          `INSERT INTO ${table(tx, 's')} (id, owner_membership_id, name, site, state, version, status)
           VALUES ($1,$2,$3,$4,$5,1,'active')`,
          [id, actor.membershipId, name, site, JSON.stringify(envelope)],
        );
        await event(tx, id, actor.membershipId, 'saved', { site });
        return one(tx, actor, id);
      });
    },

    async rename(workspaceId: string, principal: BrowserLoginsPrincipal, id: string, name: string) {
      const parsed = parse(browserLoginNameSchema, name);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        const row = await managed(tx, actor, id);
        await tx.client.query(`UPDATE ${table(tx, 's')} SET name = $2 WHERE id = $1`, [row.id, parsed]);
        await event(tx, row.id, actor.membershipId, 'renamed');
        return one(tx, actor, row.id);
      });
    },

    /** Replaces whom a login is shared with. */
    async share(workspaceId: string, principal: BrowserLoginsPrincipal, id: string, input: unknown) {
      const { grants: requested } = parse(shareBrowserLoginSchema, input);
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        const row = await managed(tx, actor, id);
        const entries = await validateGrants(tx, row.owner_membership_id, requested);
        if (row.owner_membership_id !== actor.membershipId) {
          const managers = (list: (string | null)[]) => list.filter(Boolean).sort().join(',');
          const before = (await grants(tx, [row.id]))
            .get(row.id)!
            .flatMap(grant =>
              grant.role === 'manage' && grant.grantee.kind === 'member' ? [grant.grantee.membershipId] : [],
            );
          const after = entries.flatMap(([, entry]) => (entry.role === 'manage' ? [entry.membershipId] : []));
          // Only the owner names managers; another manager may share for use or remove only themselves.
          if (
            managers(before) !== managers(after) &&
            managers(before.filter(member => member !== actor.membershipId)) !== managers(after)
          )
            throw new AccessDenied();
        }
        await tx.client.query(`DELETE FROM ${table(tx, '_grants')} WHERE login_id = $1`, [row.id]);
        for (const [key, entry] of entries)
          await tx.client.query(
            `INSERT INTO ${table(tx, '_grants')} (login_id, grantee, membership_id, team_id, role, granted_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [row.id, key, entry.membershipId, entry.teamId, entry.role, actor.membershipId],
          );
        await event(tx, row.id, actor.membershipId, 'shared', { grantees: entries.map(([key]) => key) });
        return one(tx, actor, row.id);
      });
    },

    /** Deletes a login and its saved state for good. */
    async remove(workspaceId: string, principal: BrowserLoginsPrincipal, id: string) {
      return authorized(workspaceId, principal, 'write', async (tx, actor) => {
        const row = await managed(tx, actor, id);
        await tx.client.query(`DELETE FROM ${table(tx, '_grants')} WHERE login_id = $1`, [row.id]);
        await tx.client.query(
          `UPDATE ${table(tx, 's')} SET status = 'deleted', state = NULL, deleted_at = clock_timestamp() WHERE id = $1`,
          [row.id],
        );
        await event(tx, row.id, actor.membershipId, 'deleted');
      });
    },

    /** Decrypts a login the member can use, for loading into their session. */
    async use(workspaceId: string, principal: BrowserLoginsPrincipal, id: string): Promise<BrowserLoginState> {
      requireEnabled();
      return authorized(workspaceId, principal, 'read', async (tx, actor) => {
        const row = await load(tx, id);
        const rights = await access(tx, actor.membershipId, row);
        if (!rights.use) {
          if (rights.manage) throw new BrowserLoginError('unavailable');
          throw new AccessDenied();
        }
        const state = cipher.decrypt(workspaceId, row);
        await tx.client.query(`UPDATE ${table(tx, 's')} SET last_used_at = clock_timestamp() WHERE id = $1`, [row.id]);
        await event(tx, row.id, actor.membershipId, 'used');
        return { id: row.id, site: row.site, version: row.version, state };
      });
    },

    /**
     * Saves what a session holds for a login back at the end of a turn. A session that was asked to sign in again
     * marks the login as needing sign-in and keeps its state. Skips a login the member can no longer use.
     */
    async saveBack(
      workspaceId: string,
      principal: BrowserLoginsPrincipal,
      input: BrowserLoginSaveBack,
    ): Promise<'saved' | 'needs-sign-in' | 'skipped'> {
      requireEnabled();
      const { id, signedOut, state } = parse(browserLoginSaveBackSchema, input);
      return authorized(workspaceId, principal, 'read', async (tx, actor) => {
        let row: Row;
        try {
          row = await load(tx, id);
        } catch (error) {
          if (error instanceof AccessDenied) return 'skipped';
          throw error;
        }
        if (!(await access(tx, actor.membershipId, row)).use) return 'skipped';
        if (signedOut) {
          if (!row.needs_sign_in) {
            await tx.client.query(`UPDATE ${table(tx, 's')} SET needs_sign_in = true WHERE id = $1`, [row.id]);
            await event(tx, row.id, actor.membershipId, 'signed-out');
          }
          return 'needs-sign-in';
        }
        if (!state) return 'skipped';
        const version = row.version + 1;
        let envelope;
        try {
          envelope = cipher.encrypt(workspaceId, row.id, version, state);
        } catch (error) {
          if (error instanceof BrowserLoginError && error.code === 'too-large') return 'skipped';
          throw error;
        }
        await tx.client.query(
          `UPDATE ${table(tx, 's')} SET state = $2, version = $3, needs_sign_in = false, saved_at = clock_timestamp()
           WHERE id = $1`,
          [row.id, JSON.stringify(envelope), version],
        );
        await event(tx, row.id, actor.membershipId, 'refreshed', { version });
        return 'saved';
      });
    },
  };
}
export type BrowserLogins = ReturnType<typeof createBrowserLogins>;
