import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied, currentMember, resolveHuman } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { isFeatureEnabled } from '@tulipfarm/observability';
import {
  accessTokenScopeSchema,
  mintAccessToken,
  parseAccessToken,
  type AccessTokenScope,
} from './access-token-secret.ts';

export const accessTokenExpirySchema = z.enum(['30d', '90d', '365d', 'never']);
export const createAccessTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(accessTokenScopeSchema).min(1).max(6),
  tableIds: z.array(z.uuid()).min(1).max(100).nullable().default(null),
  expiry: accessTokenExpirySchema,
});
export const accessTokenSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  ownerUserId: z.string(),
  ownerName: z.string().nullable(),
  scopes: z.array(accessTokenScopeSchema),
  tableIds: z.array(z.uuid()).nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type AccessTokenView = z.infer<typeof accessTokenSchema>;

/** Who a valid token acts for, and how far its authority reaches. */
export type TokenPrincipal = {
  tokenId: string;
  workspaceId: string;
  userId: string;
  scopes: ReadonlySet<AccessTokenScope>;
  /** Null when the token can use every table its owner can. */
  tableIds: ReadonlySet<string> | null;
};

export class AccessTokenError extends Error {
  readonly code: 'external-access-disabled' | 'not-found' | 'feature-unavailable';
  constructor(code: AccessTokenError['code']) {
    super(code);
    this.code = code;
  }
}

const days = { '30d': 30, '90d': 90, '365d': 365, never: null } as const;
const iso = (value: Date | null) => (value ? value.toISOString() : null);

type Row = {
  id: string;
  name: string;
  user_id: string;
  owner_name: string | null;
  scopes: string[];
  table_ids: string[] | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
};
const view = (row: Row): AccessTokenView => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.user_id,
  ownerName: row.owner_name,
  scopes: z.array(accessTokenScopeSchema).parse(row.scopes),
  tableIds: row.table_ids,
  createdAt: row.created_at.toISOString(),
  expiresAt: iso(row.expires_at),
  lastUsedAt: iso(row.last_used_at),
  revokedAt: iso(row.revoked_at),
});

/**
 * Personal access tokens. A token acts as one member of one workspace. It is accepted only while the workspace has
 * external access turned on, the `external-access` flag is on for it, the member still belongs to it, and the token is
 * neither expired nor revoked. Every request checks all four again, so none of them is cached past a minute.
 */
export function createAccessTokens(dependencies: {
  pool: Pick<Pool, 'query'>;
  runtime: Pick<WorkspaceRuntime, 'transaction'>;
  flag?: (workspaceId: string) => Promise<boolean>;
  now?: () => Date;
}) {
  const { pool, runtime } = dependencies;
  const flag = dependencies.flag ?? (id => isFeatureEnabled('external-access', null, { id }));
  const now = dependencies.now ?? (() => new Date());

  /** The caller's membership in the workspace, or a denial when they have none. */
  const member = (workspaceId: string, userId: string) =>
    runtime.transaction(workspaceId, commonCompatibility, async tx =>
      currentMember(tx, await resolveHuman(tx, userId)),
    );

  async function enabled(workspaceId: string) {
    const result = await pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM app.workspace_external_access WHERE workspace_id = $1',
      [workspaceId],
    );
    return result.rows[0]?.enabled === true;
  }

  async function settings(workspaceId: string, userId: string) {
    const [membership, available] = await Promise.all([member(workspaceId, userId), flag(workspaceId)]);
    return { available, enabled: available && (await enabled(workspaceId)), admin: membership.role === 'admin' };
  }

  async function setEnabled(workspaceId: string, userId: string, value: boolean) {
    if (!(await flag(workspaceId))) throw new AccessTokenError('feature-unavailable');
    if ((await member(workspaceId, userId)).role !== 'admin') throw new AccessDenied();
    await pool.query(
      `INSERT INTO app.workspace_external_access (workspace_id, enabled, changed_by) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by,
         changed_at = CURRENT_TIMESTAMP`,
      [workspaceId, value, userId],
    );
    return settings(workspaceId, userId);
  }

  /** The caller's own tokens, or every token in the workspace for an admin who asks for `all`. */
  async function list(workspaceId: string, userId: string, all = false) {
    const membership = await member(workspaceId, userId);
    if (all && membership.role !== 'admin') throw new AccessDenied();
    const result = await pool.query<Row>(
      `SELECT t.id, t.name, t.user_id, u.name AS owner_name, t.scopes, t.table_ids, t.created_at, t.expires_at,
              t.last_used_at, t.revoked_at
         FROM app.access_tokens t LEFT JOIN app.users u ON u.id = t.user_id
        WHERE t.workspace_id = $1 AND ($2::boolean OR t.user_id = $3)
        ORDER BY t.created_at DESC LIMIT 500`,
      [workspaceId, all, userId],
    );
    return result.rows.map(view);
  }

  async function create(workspaceId: string, userId: string, input: unknown) {
    const parsed = createAccessTokenSchema.parse(input);
    await member(workspaceId, userId);
    if (!(await flag(workspaceId))) throw new AccessTokenError('feature-unavailable');
    if (!(await enabled(workspaceId))) throw new AccessTokenError('external-access-disabled');
    const minted = mintAccessToken();
    const created = now();
    const expiryDays = days[parsed.expiry];
    const expires = expiryDays === null ? null : new Date(created.getTime() + expiryDays * 86_400_000);
    const result = await pool.query<Row>(
      `WITH inserted AS (
         INSERT INTO app.access_tokens (id, secret_sha256, workspace_id, user_id, name, scopes, table_ids, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *)
       SELECT i.id, i.name, i.user_id, u.name AS owner_name, i.scopes, i.table_ids, i.created_at, i.expires_at,
              i.last_used_at, i.revoked_at
         FROM inserted i LEFT JOIN app.users u ON u.id = i.user_id`,
      [
        minted.id,
        minted.digest,
        workspaceId,
        userId,
        parsed.name,
        [...new Set(parsed.scopes)].sort(),
        parsed.tableIds ? [...new Set(parsed.tableIds)] : null,
        created,
        expires,
      ],
    );
    return { token: minted.token, accessToken: view(result.rows[0]!) };
  }

  /** The owner revokes their own token; an admin can revoke anyone's. Revoking twice keeps the first time. */
  async function revoke(workspaceId: string, userId: string, tokenId: string) {
    z.uuid().parse(tokenId);
    const membership = await member(workspaceId, userId);
    const result = await pool.query<Row>(
      `WITH changed AS (
         UPDATE app.access_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                revoked_by = COALESCE(revoked_by, $3)
          WHERE id = $1 AND workspace_id = $2 AND ($4::boolean OR user_id = $3) RETURNING *)
       SELECT c.id, c.name, c.user_id, u.name AS owner_name, c.scopes, c.table_ids, c.created_at, c.expires_at,
              c.last_used_at, c.revoked_at
         FROM changed c LEFT JOIN app.users u ON u.id = c.user_id`,
      [tokenId, workspaceId, userId, membership.role === 'admin'],
    );
    if (!result.rows[0]) throw new AccessTokenError('not-found');
    return view(result.rows[0]);
  }

  /**
   * The principal a presented bearer value acts for, or null when it is not a live token. A token whose owner has left
   * the workspace is refused here too, so removal takes effect on the next request.
   */
  async function authenticate(presented: string): Promise<TokenPrincipal | null> {
    const parsed = parseAccessToken(presented);
    if (!parsed) return null;
    const result = await pool.query<{
      workspace_id: string;
      user_id: string;
      scopes: string[];
      table_ids: string[] | null;
      last_used_at: Date | null;
    }>(
      `SELECT t.workspace_id, t.user_id, t.scopes, t.table_ids, t.last_used_at
         FROM app.access_tokens t JOIN app.workspace_external_access e ON e.workspace_id = t.workspace_id
        WHERE t.id = $1 AND t.secret_sha256 = $2 AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP) AND e.enabled`,
      [parsed.id, parsed.digest],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!(await flag(row.workspace_id))) return null;
    try {
      await member(row.workspace_id, row.user_id);
    } catch {
      return null;
    }
    if (!row.last_used_at || now().getTime() - row.last_used_at.getTime() > 60_000)
      await pool
        .query('UPDATE app.access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [parsed.id])
        .catch(() => undefined);
    return {
      tokenId: parsed.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      scopes: new Set(z.array(accessTokenScopeSchema).parse(row.scopes)),
      tableIds: row.table_ids ? new Set(row.table_ids) : null,
    };
  }

  return { settings, setEnabled, list, create, revoke, authenticate };
}
export type AccessTokens = ReturnType<typeof createAccessTokens>;
