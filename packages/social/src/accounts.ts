import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import { validateIntegrationRecipients } from '@tulipfarm/integrations/authorization';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import type { PlatformAppCredentials, RefreshPolicy, SocialPlatformAdapter, TokenSet } from './adapter.ts';
import {
  accessTierSchema,
  accountIdentitySchema,
  accountStateSchema,
  appSourceSchema,
  beginConnectionSchema,
  platformAppCreateSchema,
  platformSchema,
  platforms,
  socialAccountGrantsSchema,
  socialAccountLimits,
  type AccountState,
  type Platform,
  type PlatformAppMetadata,
  type PlatformAvailability,
  type SocialAccountGrants,
  type SocialAccountMetadata,
} from './contracts.ts';
import { SocialError, socialCredentialCipher, type CredentialBinding } from './credentials.ts';
import {
  capabilitiesFor,
  platformAvailability,
  type PlatformAppResolution,
  type PlatformApps,
  type ResolvedPlatformApp,
} from './platform-apps.ts';

export type SocialRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
/** Social tables arrive with common migration 4. */
export const socialCompatibility = Object.freeze({ minimum: 4, maximum: commonCompatibility.maximum });

/** A refresh still running after this long is treated as failed. */
export const staleRefreshMs = 30_000;
/** A token used within this many seconds of its expiry is refreshed first. */
export const inlineRefreshSkewSeconds = 60;
/** How far ahead of expiry the worker sweep refreshes each policy's tokens. */
export const refreshWindowSeconds = {
  'refresh-token': 10 * 60,
  'long-lived-exchange': 7 * 24 * 60 * 60,
  none: 0,
} as const satisfies Record<RefreshPolicy, number>;
const attemptLifetime = '10 minutes';
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;

const uuid = z.uuid();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const accountRowSchema = z.object({
  id: z.uuid(),
  platform: platformSchema,
  ownership: z.enum(['personal', 'business']),
  owner_membership_id: z.uuid().nullable(),
  owning_team_id: z.uuid().nullable(),
  app_source: appSourceSchema,
  platform_app_id: z.uuid().nullable(),
  app_generation: z.number().int().nullable(),
  app_fingerprint: z.string().nullable(),
  generation: z.number().int().positive(),
  grants_version: z.number().int().positive(),
  state: accountStateSchema,
  identity: accountIdentitySchema.nullable(),
  scopes: z.array(z.string()),
  credential: z.unknown(),
  credential_version: z.number().int().positive(),
  expires_at: z.date().nullable(),
  refresh_started_at: z.date().nullable(),
});
type AccountRow = z.infer<typeof accountRowSchema>;
const appRowSchema = z.object({
  id: z.uuid(),
  platform: platformSchema,
  name: z.string(),
  client_id: z.string(),
  client_secret: z.unknown(),
  access_tier: accessTierSchema,
  generation: z.number().int().positive(),
  created_at: z.date(),
});
type AppRow = z.infer<typeof appRowSchema>;
const attemptSchema = z.object({ account_id: z.uuid(), generation: z.number().int(), verifier: z.unknown() });
const storedTokensSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
});
const scopesSchema = z.array(z.string().min(1).max(256)).max(64);
const callbackSchema = z.strictObject({
  state: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(4096).nullable(),
});
const replaceSecretSchema = z.strictObject({ clientSecret: z.string().min(1).max(4096) });

/** True while work bound at `boundGeneration` may still use the account (PRODUCT 7, 8). */
export function generationCurrent(account: { generation: number; state: AccountState }, boundGeneration: number) {
  return account.generation === boundGeneration && account.state !== 'disconnected';
}

/**
 * What a membership may do with a connection. A personal connection is its owner's alone; a shared one has
 * separate `use` and `manage` grants to members and teams (PRODUCT 9).
 */
export async function socialAccountAccess(
  tx: AuthorizationTransaction,
  membershipId: string,
  account: { id: string; ownership: 'personal' | 'business'; ownerMembershipId: string | null },
) {
  if (account.ownership === 'personal') {
    const owner = account.ownerMembershipId === membershipId;
    return { read: owner, use: owner, manage: owner };
  }
  const granted = z
    .array(z.object({ permission: z.enum(['use', 'manage']) }))
    .parse(
      (
        await tx.client.query(
          `SELECT DISTINCT g.permission FROM ${qualified(tx.schema, 'tf_social_account_grants')} g
           LEFT JOIN ${qualified(tx.schema, 'tf_member_teams')} mt ON mt.team_id=g.team_id AND mt.membership_id=$2
           WHERE g.account_id=$1 AND (g.membership_id=$2 OR mt.membership_id IS NOT NULL)`,
          [account.id, membershipId],
        )
      ).rows,
    )
    .map(grant => grant.permission);
  const manage = granted.includes('manage');
  const use = granted.includes('use');
  return { read: manage || use, use, manage };
}

export type AccessToken = {
  token: TokenSet;
  account: { id: string; platform: Platform; generation: number; credentialVersion: number };
  app: PlatformAppCredentials;
};

export function createSocialAccounts(options: {
  runtime: SocialRuntime;
  keyring: IntegrationKeyring;
  platformApps: PlatformApps;
  /** Shipped adapters; a platform without one is not offered (PRODUCT 1). */
  adapters: Partial<Record<Platform, SocialPlatformAdapter>>;
}) {
  const cipher = socialCredentialCipher(options.keyring);
  const { platformApps } = options;
  const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_social_${name}`);
  const adapterFor = (platform: Platform) => {
    const adapter = options.adapters[platform];
    if (!adapter || adapter.platform !== platform) throw new SocialError('platform-unavailable');
    return adapter;
  };
  const tokenBinding = (workspaceId: string, row: AccountRow, credentialVersion = row.credential_version) =>
    ({
      purpose: 'tokens',
      workspaceId,
      accountId: row.id,
      platform: row.platform,
      generation: row.generation,
      credentialVersion,
    }) satisfies CredentialBinding;
  const pkceBinding = (workspaceId: string, row: AccountRow) =>
    ({
      purpose: 'pkce',
      workspaceId,
      accountId: row.id,
      platform: row.platform,
      generation: row.generation,
    }) satisfies CredentialBinding;
  const secretBinding = (workspaceId: string, app: { id: string; platform: Platform; generation: number }) =>
    ({
      purpose: 'app-secret',
      workspaceId,
      platformAppId: app.id,
      platform: app.platform,
      generation: app.generation,
    }) satisfies CredentialBinding;

  async function transaction<T>(workspaceId: string, operation: (tx: AuthorizationTransaction) => Promise<T>) {
    return options.runtime.transaction(uuid.parse(workspaceId), socialCompatibility, operation);
  }
  async function authorized<T>(
    workspaceId: string,
    principal: string | HumanActor,
    operation: (tx: AuthorizationTransaction, actor: HumanActor, role: 'admin' | 'member') => Promise<T>,
    mode: 'read' | 'write' = 'read',
  ) {
    return transaction(workspaceId, async tx => {
      await lockAuthorization(tx, mode);
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      const member = await currentMember(tx, actor);
      return operation(tx, actor, member.role);
    });
  }
  async function load(tx: AuthorizationTransaction, id: string, lock = false) {
    const row = accountRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT * FROM ${relation(tx, 'accounts')} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [
            uuid.parse(id),
          ])
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function loadApp(tx: AuthorizationTransaction, id: string, lock = false) {
    const row = appRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'platform_apps')} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
            [uuid.parse(id)],
          )
        ).rows[0],
      );
    if (!row) throw new SocialError('platform-app-not-found');
    return row;
  }
  function workspaceApp(workspaceId: string, row: AppRow): ResolvedPlatformApp {
    return platformApps.workspace({
      id: row.id,
      platform: row.platform,
      generation: row.generation,
      clientId: row.client_id,
      clientSecret: cipher.decrypt(secretBinding(workspaceId, row), row.client_secret),
      accessTier: row.access_tier,
    });
  }
  function appMetadata(row: AppRow): PlatformAppMetadata {
    return {
      id: row.id,
      platform: row.platform,
      name: row.name,
      clientId: row.client_id,
      accessTier: row.access_tier,
      generation: row.generation,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * The app an account was authorized through, checked against what it is now. A replaced app makes the
   * account `reconnect-required` (PRODUCT 6); an app that is no longer offered leaves it `disabled` (PRODUCT 5).
   */
  async function currentApp(
    tx: AuthorizationTransaction,
    workspaceId: string,
    row: AccountRow,
  ): Promise<{ kind: 'app'; app: ResolvedPlatformApp } | { kind: 'replaced' } | { kind: 'disabled' }> {
    if (!options.adapters[row.platform]) return { kind: 'disabled' };
    if (row.app_source === 'workspace') {
      const app = await loadApp(tx, row.platform_app_id!);
      if (app.generation !== row.app_generation) return { kind: 'replaced' };
      return { kind: 'app', app: workspaceApp(workspaceId, app) };
    }
    const resolution = await platformApps.resolveDefault(row.platform, workspaceId);
    if (resolution.kind !== 'app' || resolution.app.source !== row.app_source) return { kind: 'disabled' };
    if (resolution.app.fingerprint !== row.app_fingerprint) return { kind: 'replaced' };
    return resolution;
  }
  function staleRefresh(row: AccountRow) {
    return row.state === 'refreshing' && (row.refresh_started_at?.getTime() ?? 0) < Date.now() - staleRefreshMs;
  }
  async function effectiveState(tx: AuthorizationTransaction, workspaceId: string, row: AccountRow) {
    if (staleRefresh(row)) return 'reconnect-required';
    if (!['active', 'refreshing', 'reconnect-required'].includes(row.state)) return row.state;
    const app = await currentApp(tx, workspaceId, row);
    if (app.kind === 'disabled') return 'disabled';
    if (app.kind === 'replaced') return 'reconnect-required';
    return row.state;
  }
  const capabilities = (tx: AuthorizationTransaction, actor: HumanActor, row: AccountRow) =>
    socialAccountAccess(tx, actor.membershipId, {
      id: row.id,
      ownership: row.ownership,
      ownerMembershipId: row.owner_membership_id,
    });
  async function permit(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    row: AccountRow,
    action: 'read' | 'use' | 'manage',
  ) {
    if (!(await capabilities(tx, actor, row))[action]) throw new AccessDenied();
  }
  async function metadata(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    row: AccountRow,
  ): Promise<SocialAccountMetadata> {
    const access = await capabilities(tx, actor, row);
    if (!access.read) throw new AccessDenied();
    const state = await effectiveState(tx, workspaceId, row);
    return {
      id: row.id,
      platform: row.platform,
      ownership:
        row.ownership === 'personal' ? { kind: 'personal' } : { kind: 'business', owningTeamId: row.owning_team_id! },
      appSource: row.app_source,
      platformAppId: row.platform_app_id,
      state,
      identity: row.identity,
      scopes: row.scopes,
      generation: row.generation,
      grantsVersion: row.grants_version,
      capabilities: { ...access, use: access.use && state === 'active' },
    };
  }
  async function accountGrants(tx: AuthorizationTransaction, id: string) {
    const rows = z
      .array(
        z.object({
          permission: z.enum(['use', 'manage']),
          membership_id: z.uuid().nullable(),
          team_id: z.uuid().nullable(),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT permission,membership_id,team_id FROM ${relation(tx, 'account_grants')} WHERE account_id=$1 ORDER BY membership_id,team_id`,
            [id],
          )
        ).rows,
      );
    const set = (permission: 'use' | 'manage') => ({
      memberIds: rows.flatMap(row => (row.permission === permission && row.membership_id ? [row.membership_id] : [])),
      teamIds: rows.flatMap(row => (row.permission === permission && row.team_id ? [row.team_id] : [])),
    });
    return { use: set('use'), manage: set('manage') };
  }
  async function audit(tx: AuthorizationTransaction, actor: HumanActor | null, id: string, operation: string) {
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), actor?.membershipId ?? 'system', `social-account.${operation}`, id],
    );
  }
  /** Stops all work bound to the account: the credential is cleared and `generation` increases (PRODUCT 7, 8). */
  async function requireReconnect(tx: AuthorizationTransaction, row: AccountRow, reason: string) {
    const updated = await tx.client.query(
      `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',generation=generation+1,credential=NULL,expires_at=NULL,refresh_started_at=NULL
       WHERE id=$1 AND generation=$2 AND state IN ('active','refreshing') RETURNING id`,
      [row.id, row.generation],
    );
    if (updated.rowCount) await audit(tx, null, row.id, `reconnect-required.${reason}`);
  }
  function requestedScopes(adapter: SocialPlatformAdapter, app: ResolvedPlatformApp) {
    return scopesSchema.parse(adapter.scopes(app.accessTier, capabilitiesFor(adapter.platform, app.accessTier)));
  }
  function credentials(app: ResolvedPlatformApp): PlatformAppCredentials {
    return { clientId: app.clientId, clientSecret: app.clientSecret, accessTier: app.accessTier };
  }
  async function chooseApp(
    tx: AuthorizationTransaction,
    workspaceId: string,
    platform: Platform,
    platformAppId: string | null | undefined,
  ) {
    if (platformAppId) {
      const app = await loadApp(tx, platformAppId);
      if (app.platform !== platform) throw new SocialError('platform-app-not-found');
      return workspaceApp(workspaceId, app);
    }
    return resolved(await platformApps.resolveDefault(platform, workspaceId));
  }
  function resolved(resolution: PlatformAppResolution) {
    if (resolution.kind === 'workspace-app-required') throw new SocialError('workspace-app-required');
    if (resolution.kind === 'unavailable') throw new SocialError('platform-unavailable');
    return resolution.app;
  }
  async function reserveAttempt(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    sessionId: string,
    row: AccountRow,
    app: ResolvedPlatformApp,
  ) {
    const adapter = adapterFor(row.platform);
    const state = `${workspaceId}.${randomBytes(32).toString('base64url')}`;
    const verifier = randomBytes(32).toString('base64url');
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'account_attempts')} (account_id,generation,state_hash,session_hash,membership_id,state,verifier,expires_at)
       VALUES ($1,$2,$3,$4,$5,'reserved',$6,clock_timestamp()+interval '${attemptLifetime}')
       ON CONFLICT (account_id) DO UPDATE SET generation=EXCLUDED.generation,state_hash=EXCLUDED.state_hash,session_hash=EXCLUDED.session_hash,
         membership_id=EXCLUDED.membership_id,state='reserved',verifier=EXCLUDED.verifier,expires_at=EXCLUDED.expires_at`,
      [
        row.id,
        row.generation,
        hash(state),
        hash(sessionId),
        actor.membershipId,
        cipher.encrypt(pkceBinding(workspaceId, row), verifier),
      ],
    );
    const authorizationUrl = adapter.authorizationUrl({
      app: { clientId: app.clientId, accessTier: app.accessTier },
      redirectUri: app.redirectUri,
      state,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      scopes: requestedScopes(adapter, app),
    });
    return { authorizationUrl: authorizationUrl.toString(), attemptId: row.id };
  }
  async function invalidateAttempt(workspaceId: string, id: string, generation: number) {
    await transaction(workspaceId, async tx => {
      await lockAuthorization(tx);
      await tx.client.query(
        `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',credential=NULL,expires_at=NULL,refresh_started_at=NULL WHERE id=$1 AND generation=$2 AND state='authorizing'`,
        [id, generation],
      );
      await tx.client.query(
        `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1 AND generation=$2`,
        [id, generation],
      );
    });
  }

  /**
   * A usable token. An expired or nearly expired one is refreshed first under the account's row lock; the
   * refresh keeps `generation` and increases `credential_version` (PRODUCT 8).
   */
  async function obtain(workspaceId: string, accountId: string, windowSeconds: number | null): Promise<AccessToken> {
    const prepared = await transaction(workspaceId, async tx => {
      await lockAuthorization(tx);
      const row = await load(tx, accountId, true);
      if (staleRefresh(row)) {
        await requireReconnect(tx, row, 'stale-refresh');
        return { failure: new SocialError('account-reconnect-required') };
      }
      if (row.state === 'refreshing') return { failure: new SocialError('account-unavailable') };
      if (row.state !== 'active')
        return {
          failure: new SocialError(
            row.state === 'reconnect-required' ? 'account-reconnect-required' : 'account-unavailable',
          ),
        };
      const current = await currentApp(tx, workspaceId, row);
      if (current.kind === 'disabled') return { failure: new SocialError('platform-unavailable') };
      if (current.kind === 'replaced') {
        await requireReconnect(tx, row, 'app-replaced');
        return { failure: new SocialError('account-reconnect-required') };
      }
      const adapter = adapterFor(row.platform);
      const stored = storedTokensSchema.parse(
        JSON.parse(cipher.decrypt(tokenBinding(workspaceId, row), row.credential)),
      );
      const token: TokenSet = { ...stored, expiresAt: row.expires_at, scopes: row.scopes };
      const result = {
        token,
        account: {
          id: row.id,
          platform: row.platform,
          generation: row.generation,
          credentialVersion: row.credential_version,
        },
        app: credentials(current.app),
      };
      const policy: RefreshPolicy = adapter.refresh ? adapter.refreshPolicy : 'none';
      const now = Date.now();
      const expired = row.expires_at !== null && row.expires_at.getTime() <= now;
      const window = windowSeconds ?? (policy === 'none' ? 0 : inlineRefreshSkewSeconds);
      const due = row.expires_at !== null && row.expires_at.getTime() <= now + window * 1000;
      if (!due) return { ready: result };
      const refreshable =
        (policy === 'refresh-token' && stored.refreshToken !== null) || (policy === 'long-lived-exchange' && !expired);
      if (!refreshable) {
        if (!expired) return { ready: result };
        await requireReconnect(tx, row, 'expired');
        return { failure: new SocialError('account-reconnect-required') };
      }
      await tx.client.query(
        `UPDATE ${relation(tx, 'accounts')} SET state='refreshing',refresh_started_at=clock_timestamp() WHERE id=$1`,
        [row.id],
      );
      return { refresh: { ...result, row, adapter } };
    });
    if ('failure' in prepared) throw prepared.failure;
    if ('ready' in prepared) return prepared.ready;
    const { row, adapter, ...current } = prepared.refresh;
    let refreshed: TokenSet;
    try {
      refreshed = await adapter.refresh!(current.token, current.app);
    } catch (error) {
      const rejected = ['reconnect', 'rejected'].includes(
        adapter.classify(error instanceof Error ? error : new Error(String(error)), 'before-send'),
      );
      await transaction(workspaceId, async tx => {
        await lockAuthorization(tx);
        const latest = await load(tx, row.id, true);
        if (latest.generation !== row.generation || latest.state !== 'refreshing') return;
        if (rejected) await requireReconnect(tx, latest, 'refresh-rejected');
        else
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET state='active',refresh_started_at=NULL WHERE id=$1`,
            [row.id],
          );
      });
      throw new SocialError(rejected ? 'account-reconnect-required' : 'account-unavailable');
    }
    const settled = await transaction(workspaceId, async tx => {
      await lockAuthorization(tx);
      const latest = await load(tx, row.id, true);
      if (
        latest.generation !== row.generation ||
        latest.credential_version !== row.credential_version ||
        latest.state !== 'refreshing'
      )
        return null;
      const scopes = scopesSchema.parse(refreshed.scopes.length ? refreshed.scopes : latest.scopes);
      if (latest.scopes.some(scope => !scopes.includes(scope))) {
        // Returned rather than thrown, so the state change commits.
        await requireReconnect(tx, latest, 'scopes-reduced');
        return null;
      }
      const tokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? current.token.refreshToken,
      };
      const credentialVersion = latest.credential_version + 1;
      await tx.client.query(
        `UPDATE ${relation(tx, 'accounts')} SET state='active',refresh_started_at=NULL,credential=$2,credential_version=$3,expires_at=$4,scopes=$5 WHERE id=$1`,
        [
          latest.id,
          cipher.encrypt(tokenBinding(workspaceId, latest, credentialVersion), JSON.stringify(tokens)),
          credentialVersion,
          refreshed.expiresAt,
          scopes,
        ],
      );
      await audit(tx, null, latest.id, 'refreshed');
      return {
        token: { ...tokens, expiresAt: refreshed.expiresAt, scopes },
        account: { ...current.account, credentialVersion },
        app: current.app,
      };
    });
    if (!settled) throw new SocialError('account-reconnect-required');
    return settled;
  }

  async function reserve(
    workspaceId: string,
    userId: string,
    sessionId: string,
    input: unknown,
  ): Promise<{ authorizationUrl: string; attemptId: string }> {
    const value = beginConnectionSchema.parse(input);
    adapterFor(value.platform);
    return authorized(
      workspaceId,
      userId,
      async (tx, actor) => {
        const app = await chooseApp(tx, workspaceId, value.platform, value.platformAppId);
        if (value.ownership.kind === 'business') {
          const member = await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE team_id=$1 AND membership_id=$2`,
            [value.ownership.owningTeamId, actor.membershipId],
          );
          if (member.rowCount !== 1) throw new AccessDenied();
        }
        const counts = z.object({ total: z.number(), owned: z.number() }).parse(
          (
            await tx.client.query(
              `SELECT count(*)::integer AS total,
                 count(*) FILTER (WHERE ownership=$1 AND ($1='business' OR owner_membership_id=$2))::integer AS owned
               FROM ${relation(tx, 'accounts')} WHERE state<>'disconnected'`,
              [value.ownership.kind, actor.membershipId],
            )
          ).rows[0],
        );
        if (counts.total >= socialAccountLimits.workspace || counts.owned >= socialAccountLimits[value.ownership.kind])
          throw new SocialError('account-limit-reached');
        const id = randomUUID();
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'accounts')} (id,platform,ownership,owner_membership_id,owning_team_id,app_source,platform_app_id,app_generation,app_fingerprint,state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'authorizing')`,
          [
            id,
            value.platform,
            value.ownership.kind,
            value.ownership.kind === 'personal' ? actor.membershipId : null,
            value.ownership.kind === 'business' ? value.ownership.owningTeamId : null,
            app.source,
            app.platformAppId,
            app.generation,
            app.fingerprint,
          ],
        );
        if (value.ownership.kind === 'business')
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'account_grants')} (account_id,permission,membership_id) VALUES ($1,'manage',$2),($1,'use',$2)`,
            [id, actor.membershipId],
          );
        await audit(tx, actor, id, 'begin');
        return reserveAttempt(tx, workspaceId, actor, sessionId, await load(tx, id), app);
      },
      'write',
    );
  }

  return {
    /** Every platform, and whether this workspace can connect it (PRODUCT 1–5). */
    async availability(workspaceId: string, userId: string): Promise<PlatformAvailability[]> {
      return authorized(workspaceId, userId, async tx => {
        const apps = z
          .array(z.object({ platform: platformSchema, access_tier: accessTierSchema }))
          .parse(
            (
              await tx.client.query(
                `SELECT DISTINCT ON (platform) platform,access_tier FROM ${relation(tx, 'platform_apps')} ORDER BY platform,created_at DESC,id`,
              )
            ).rows,
          );
        const result: PlatformAvailability[] = [];
        for (const platform of platforms) {
          const own = apps.find(app => app.platform === platform);
          result.push(
            platformAvailability(
              platform,
              await platformApps.resolveDefault(platform, workspaceId),
              own ? { accessTier: own.access_tier } : null,
              options.adapters[platform]?.platform === platform,
            ),
          );
        }
        return result;
      });
    },
    /** Workspace platform apps; any member may see them, never their secrets (PRODUCT 3). */
    async listApps(workspaceId: string, userId: string): Promise<PlatformAppMetadata[]> {
      return authorized(workspaceId, userId, async tx =>
        z
          .array(appRowSchema)
          .parse(
            (await tx.client.query(`SELECT * FROM ${relation(tx, 'platform_apps')} ORDER BY created_at,id LIMIT 1000`))
              .rows,
          )
          .map(appMetadata),
      );
    },
    /** Registers a workspace's own platform app. Workspace admins only (PRODUCT 3). */
    async createApp(workspaceId: string, userId: string, input: unknown): Promise<PlatformAppMetadata> {
      const value = platformAppCreateSchema.parse(input);
      return authorized(
        workspaceId,
        userId,
        async (tx, actor, role) => {
          if (role !== 'admin') throw new AccessDenied();
          const id = randomUUID();
          const secret = cipher.encrypt(
            secretBinding(workspaceId, { id, platform: value.platform, generation: 1 }),
            value.clientSecret,
          );
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'platform_apps')} (id,platform,name,client_id,client_secret,access_tier,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, value.platform, value.name, value.clientId, secret, value.accessTier, actor.membershipId],
          );
          await tx.client.query(
            `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'social-platform-app.create',$3)`,
            [randomUUID(), actor.membershipId, id],
          );
          return appMetadata(await loadApp(tx, id));
        },
        'write',
      );
    },
    /**
     * Replaces a workspace app's secret. Its `generation` increases, and every account authorized through an
     * older generation must reconnect (PRODUCT 6).
     */
    async replaceAppSecret(
      workspaceId: string,
      userId: string,
      appId: string,
      input: unknown,
    ): Promise<PlatformAppMetadata> {
      const value = replaceSecretSchema.parse(input);
      return authorized(
        workspaceId,
        userId,
        async (tx, actor, role) => {
          if (role !== 'admin') throw new AccessDenied();
          const app = await loadApp(tx, appId, true);
          const generation = app.generation + 1;
          await tx.client.query(
            `UPDATE ${relation(tx, 'platform_apps')} SET client_secret=$2,generation=$3 WHERE id=$1`,
            [
              app.id,
              cipher.encrypt(secretBinding(workspaceId, { ...app, generation }), value.clientSecret),
              generation,
            ],
          );
          const affected = z.array(z.object({ id: z.uuid() })).parse(
            (
              await tx.client.query(
                `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',generation=generation+1,credential=NULL,expires_at=NULL,refresh_started_at=NULL
                   WHERE platform_app_id=$1 AND app_generation<$2 AND state<>'disconnected' RETURNING id`,
                [app.id, generation],
              )
            ).rows,
          );
          for (const account of affected) {
            await tx.client.query(
              `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1`,
              [account.id],
            );
            await audit(tx, actor, account.id, 'reconnect-required.app-replaced');
          }
          await tx.client.query(
            `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'social-platform-app.replace-secret',$3)`,
            [randomUUID(), actor.membershipId, app.id],
          );
          return appMetadata(await loadApp(tx, app.id));
        },
        'write',
      );
    },
    async list(workspaceId: string, userId: string): Promise<SocialAccountMetadata[]> {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const rows = z
          .array(accountRowSchema)
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${relation(tx, 'accounts')} WHERE ownership='business' OR owner_membership_id=$1 ORDER BY created_at,id LIMIT $2`,
                [actor.membershipId, socialAccountLimits.workspace * 10],
              )
            ).rows,
          );
        const accounts: SocialAccountMetadata[] = [];
        for (const row of rows)
          if ((await capabilities(tx, actor, row)).read) accounts.push(await metadata(tx, workspaceId, actor, row));
        return accounts;
      });
    },
    async status(workspaceId: string, userId: string, id: string): Promise<SocialAccountMetadata> {
      return authorized(workspaceId, userId, async (tx, actor) => metadata(tx, workspaceId, actor, await load(tx, id)));
    },
    /** A shared connection's `use` grants and its managers. Managers only; personal connections have none (PRODUCT 9). */
    async grants(workspaceId: string, userId: string, id: string): Promise<SocialAccountGrants> {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, id);
        await permit(tx, actor, row, 'manage');
        if (row.ownership !== 'business') throw new AccessDenied();
        const granted = await accountGrants(tx, row.id);
        return {
          expectedVersion: row.grants_version,
          memberIds: granted.use.memberIds,
          teamIds: granted.use.teamIds,
          managers: granted.manage,
        };
      });
    },
    /**
     * Replaces a shared connection's `use` grants and, when given, its managers. `grantsVersion` must match
     * and increases; at least one active manager remains (PRODUCT 9).
     */
    async setGrants(workspaceId: string, userId: string, id: string, input: unknown): Promise<SocialAccountMetadata> {
      const value = socialAccountGrantsSchema.parse(input);
      return authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const row = await load(tx, id, true);
          await permit(tx, actor, row, 'manage');
          if (row.ownership !== 'business') throw new AccessDenied();
          if (row.grants_version !== value.expectedVersion) throw new SocialError('account-conflict');
          const before = await metadata(tx, workspaceId, actor, row);
          const current = await accountGrants(tx, row.id);
          const users = { memberIds: value.memberIds, teamIds: value.teamIds };
          const managers = value.managers ?? current.manage;
          await validateIntegrationRecipients(tx, actor, users, current.use.teamIds);
          await validateIntegrationRecipients(tx, actor, managers, current.manage.teamIds);
          const active = await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m WHERE m.removed_at IS NULL AND
             (m.id=ANY($1::uuid[]) OR EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=ANY($2::uuid[]))) LIMIT 1`,
            [managers.memberIds, managers.teamIds],
          );
          if (!active.rowCount) throw new SocialError('grants-invalid');
          await tx.client.query(`DELETE FROM ${relation(tx, 'account_grants')} WHERE account_id=$1`, [row.id]);
          for (const [permission, set] of [
            ['use', users],
            ['manage', managers],
          ] as const) {
            for (const memberId of new Set(set.memberIds))
              await tx.client.query(
                `INSERT INTO ${relation(tx, 'account_grants')} (account_id,permission,membership_id) VALUES ($1,$2,$3)`,
                [row.id, permission, memberId],
              );
            for (const teamId of new Set(set.teamIds))
              await tx.client.query(
                `INSERT INTO ${relation(tx, 'account_grants')} (account_id,permission,team_id) VALUES ($1,$2,$3)`,
                [row.id, permission, teamId],
              );
          }
          await tx.client.query(`UPDATE ${relation(tx, 'accounts')} SET grants_version=grants_version+1 WHERE id=$1`, [
            row.id,
          ]);
          await audit(tx, actor, row.id, 'grants');
          const updated = await load(tx, row.id);
          const access = await capabilities(tx, actor, updated);
          if (access.read) return metadata(tx, workspaceId, actor, updated);
          // The editor removed their own access; they still learn the new version.
          return { ...before, grantsVersion: updated.grants_version, capabilities: access };
        },
        'write',
      );
    },
    begin(workspaceId: string, userId: string, sessionId: string, input: unknown) {
      return reserve(workspaceId, userId, sessionId, input);
    },
    /**
     * Starts a new authorization for an account through its own platform app. `generation` increases at once,
     * so approvals, channels and scheduled variants bound to the old one stop (PRODUCT 8).
     */
    async reconnect(workspaceId: string, userId: string, sessionId: string, id: string) {
      return authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const row = await load(tx, id, true);
          await permit(tx, actor, row, 'manage');
          // A disconnected account no longer counts toward the limits, so it is connected again with begin.
          if (row.state === 'disconnected') throw new SocialError('account-conflict');
          adapterFor(row.platform);
          const app =
            row.app_source === 'workspace'
              ? workspaceApp(workspaceId, await loadApp(tx, row.platform_app_id!))
              : resolved(await platformApps.resolveDefault(row.platform, workspaceId));
          // A connection keeps the kind of app it was made with; another kind needs a new connection.
          if (app.source !== row.app_source) throw new SocialError('platform-unavailable');
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET generation=generation+1,state='authorizing',credential=NULL,expires_at=NULL,refresh_started_at=NULL,app_generation=$2,app_fingerprint=$3 WHERE id=$1`,
            [row.id, app.generation, app.fingerprint],
          );
          await audit(tx, actor, row.id, 'reconnect');
          return reserveAttempt(tx, workspaceId, actor, sessionId, await load(tx, row.id), app);
        },
        'write',
      );
    },
    /** The OAuth callback. `code` is null when the person declined. */
    async complete(code: string | null, state: string, sessionId: string, userId: string) {
      const callback = callbackSchema.parse({ code, state });
      const workspaceId = uuid.parse(callback.state.slice(0, 36));
      const prepared = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const attempt = attemptSchema.optional().parse(
            (
              await tx.client.query(
                `SELECT account_id,generation,verifier FROM ${relation(tx, 'account_attempts')}
                   WHERE state_hash=$1 AND session_hash=$2 AND membership_id=$3 AND state='reserved' AND expires_at>clock_timestamp()`,
                [hash(state), hash(sessionId), actor.membershipId],
              )
            ).rows[0],
          );
          if (!attempt) throw new AccessDenied();
          const row = await load(tx, attempt.account_id, true);
          await permit(tx, actor, row, 'manage');
          if (row.generation !== attempt.generation || row.state !== 'authorizing')
            throw new SocialError('account-conflict');
          if (callback.code === null) {
            await tx.client.query(
              `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1`,
              [row.id],
            );
            await tx.client.query(
              `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required' WHERE id=$1 AND state='authorizing'`,
              [row.id],
            );
            await audit(tx, actor, row.id, 'authorization-denied');
            return null;
          }
          const current = await currentApp(tx, workspaceId, row);
          if (current.kind !== 'app') throw new SocialError('account-conflict');
          const claimed = await tx.client.query(
            `UPDATE ${relation(tx, 'account_attempts')} SET state='exchanging',verifier=NULL
             WHERE account_id=$1 AND generation=$2 AND state_hash=$3 AND state='reserved' AND expires_at>clock_timestamp() RETURNING account_id`,
            [row.id, row.generation, hash(state)],
          );
          if (!claimed.rowCount) throw new SocialError('account-conflict');
          const verifier = cipher.decrypt(pkceBinding(workspaceId, row), attempt.verifier);
          if (!verifierPattern.test(verifier)) throw new SocialError('account-conflict');
          return { row, actor, app: current.app, verifier };
        },
        'write',
      );
      if (!prepared || callback.code === null) throw new SocialError('account-authorization-denied');
      const { row, actor, app, verifier } = prepared;
      try {
        const adapter = adapterFor(row.platform);
        const token = await adapter.exchangeCode({
          app: credentials(app),
          redirectUri: app.redirectUri,
          code: callback.code,
          codeVerifier: verifier,
        });
        const scopes = scopesSchema.parse([...new Set(token.scopes)]);
        if (requestedScopes(adapter, app).some(scope => !scopes.includes(scope)))
          throw new SocialError('account-reconnect-required');
        const identity = accountIdentitySchema.parse(await adapter.identity(token));
        for (const secret of [token.accessToken, token.refreshToken, app.clientSecret, callback.code, state, verifier])
          if (secret && JSON.stringify(identity).includes(secret)) throw new SocialError('account-reconnect-required');
        return await authorized(
          workspaceId,
          actor,
          async tx => {
            const latest = await load(tx, row.id, true);
            await permit(tx, actor, latest, 'manage');
            if (latest.generation !== row.generation || latest.state !== 'authorizing')
              throw new SocialError('account-conflict');
            await tx.client.query(
              `UPDATE ${relation(tx, 'accounts')} SET state='active',identity=$2,scopes=$3,credential=$4,expires_at=$5 WHERE id=$1`,
              [
                latest.id,
                identity,
                scopes,
                cipher.encrypt(
                  tokenBinding(workspaceId, latest),
                  JSON.stringify({ accessToken: token.accessToken, refreshToken: token.refreshToken }),
                ),
                token.expiresAt,
              ],
            );
            await tx.client.query(
              `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1 AND generation=$2`,
              [latest.id, latest.generation],
            );
            const changed = latest.identity !== null && latest.identity.platformUserId !== identity.platformUserId;
            await audit(tx, actor, latest.id, changed ? 'connected.identity-changed' : 'connected');
            return { workspaceId, account: await metadata(tx, workspaceId, actor, await load(tx, latest.id)) };
          },
          'write',
        );
      } catch {
        await invalidateAttempt(workspaceId, row.id, row.generation);
        throw new SocialError('account-reconnect-required');
      }
    },
    /** Disconnects an account: the credential is cleared and `generation` increases. */
    async disconnect(workspaceId: string, userId: string, id: string) {
      const prepared = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const row = await load(tx, id, true);
          await permit(tx, actor, row, 'manage');
          let revocation: { token: TokenSet; app: PlatformAppCredentials } | null = null;
          if (row.credential !== null && options.adapters[row.platform]?.revoke) {
            const current = await currentApp(tx, workspaceId, row);
            if (current.kind === 'app')
              revocation = {
                token: {
                  ...storedTokensSchema.parse(
                    JSON.parse(cipher.decrypt(tokenBinding(workspaceId, row), row.credential)),
                  ),
                  expiresAt: row.expires_at,
                  scopes: row.scopes,
                },
                app: credentials(current.app),
              };
          }
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET state='disconnected',generation=generation+1,credential=NULL,expires_at=NULL,refresh_started_at=NULL WHERE id=$1`,
            [row.id],
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1`,
            [row.id],
          );
          await audit(tx, actor, row.id, 'disconnect');
          return { account: await metadata(tx, workspaceId, actor, await load(tx, row.id)), revocation, row };
        },
        'write',
      );
      let providerRevocation: 'revoked' | 'failed' | 'manual-required' = 'manual-required';
      if (prepared.revocation) {
        try {
          providerRevocation = await adapterFor(prepared.row.platform).revoke!(
            prepared.revocation.token,
            prepared.revocation.app,
          );
        } catch {
          providerRevocation = 'failed';
        }
      }
      return { account: prepared.account, providerRevocation };
    },
    /**
     * Records that the platform rejected the token bound at `generation`. The account moves to
     * `reconnect-required` and work bound to it stops; nothing switches to another account (PRODUCT 7).
     */
    async tokenRejected(workspaceId: string, accountId: string, generation: number) {
      await transaction(workspaceId, async tx => {
        await lockAuthorization(tx);
        const row = await load(tx, accountId, true);
        if (row.generation === generation) await requireReconnect(tx, row, 'token-rejected');
      });
    },
    /** A usable token for platform work, refreshed inline when it is about to expire. */
    accessToken(workspaceId: string, accountId: string) {
      return obtain(workspaceId, accountId, null);
    },
    /** The worker sweep: refreshes each active account whose token falls within its policy's refresh window. */
    async refreshDue(workspaceId: string) {
      const due = await transaction(workspaceId, async tx =>
        z.array(z.object({ id: z.uuid(), platform: platformSchema })).parse(
          (
            await tx.client.query(
              `SELECT id,platform FROM ${relation(tx, 'accounts')} WHERE state='active' AND expires_at IS NOT NULL
                 AND expires_at<=clock_timestamp()+interval '${refreshWindowSeconds['long-lived-exchange']} seconds' ORDER BY expires_at LIMIT 100`,
            )
          ).rows,
        ),
      );
      const outcomes: { accountId: string; outcome: 'refreshed' | 'skipped' | 'reconnect-required' | 'failed' }[] = [];
      for (const account of due) {
        const adapter = options.adapters[account.platform];
        const policy = adapter?.refresh ? adapter.refreshPolicy : 'none';
        if (policy === 'none') continue;
        try {
          const before = await transaction(workspaceId, async tx => (await load(tx, account.id)).credential_version);
          const result = await obtain(workspaceId, account.id, refreshWindowSeconds[policy]);
          outcomes.push({
            accountId: account.id,
            outcome: result.account.credentialVersion > before ? 'refreshed' : 'skipped',
          });
        } catch (error) {
          outcomes.push({
            accountId: account.id,
            outcome:
              error instanceof SocialError && error.code === 'account-reconnect-required'
                ? 'reconnect-required'
                : 'failed',
          });
        }
      }
      return outcomes;
    },
  };
}
export type SocialAccounts = ReturnType<typeof createSocialAccounts>;
