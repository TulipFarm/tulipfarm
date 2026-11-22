import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  type AuthorizationTransaction,
  currentMember,
  type HumanActor,
  lockAndResolveHuman,
} from '@tulipfarm/access';
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import type { IntegrationKeyring } from './credentials.ts';
import { planTokenCipher } from './plan-cipher.ts';
import { hasPlanAccounts, maxPlanAccounts, nextGeneration } from './plan-accounts.ts';

/**
 * Claude and GitHub Copilot plans. A member connects with a long-lived token: a Claude token from Claude Code's own
 * sign-in (the member pastes the code Claude shows) or `claude setup-token`, or a GitHub token from the device sign-in
 * below or one they paste. The token is checked with the vendor, encrypted, and stored on one of the member's
 * connections. A member may connect several accounts of each provider.
 */
export const tokenPlanProviders = ['claude', 'copilot'] as const;
export type TokenPlanProvider = (typeof tokenPlanProviders)[number];

export const tokenPlanErrorCodes = [
  'attempt-not-found',
  'attempt-expired',
  'authorization-declined',
  'authorization-failed',
  'token-invalid',
  'token-rejected',
  'not-eligible',
  'not-connected',
  'reconnect-required',
  'device-sign-in-unavailable',
  'too-many-accounts',
  'code-invalid',
  'rate-limited',
  'unavailable',
] as const;
export type TokenPlanErrorCode = (typeof tokenPlanErrorCodes)[number];
export class TokenPlanError extends Error {
  readonly provider: TokenPlanProvider;
  readonly code: TokenPlanErrorCode;
  constructor(provider: TokenPlanProvider, code: TokenPlanErrorCode) {
    super(`${provider}-${code}`);
    this.provider = provider;
    this.code = code;
    this.name = 'TokenPlanError';
  }
}

export type TokenPlanModel = { slug: string; label: string };
export type TokenPlanStatus = {
  connectionId: string;
  state: 'not-connected' | 'connected' | 'reconnect-required' | 'signed-out';
  /** The account the token belongs to when the vendor names it, such as a GitHub login. */
  account: string | null;
  /** For Copilot, the personal GitHub account the connection uses instead of a token of its own. */
  githubAccountId?: string | null;
  planUsage: boolean;
  models: TokenPlanModel[];
  createdAt: string;
};
export type TokenPlanAttemptStatus = { status: 'pending' | 'completed' | 'failed'; errorCode: string | null };
/**
 * Checks a token with the vendor and returns the models it may use and the account it belongs to. It throws a
 * `TokenPlanError` with `token-rejected`, `not-eligible`, `rate-limited` or `unavailable`. A plan that has reached its
 * usage limit still connects: `verify` returns normally for it, with `fallback` set when the vendor couldn't list the
 * plan's own models and `models` are the catalog's instead.
 */
export type TokenPlanVerifier = (
  token: string,
) => Promise<{ models: TokenPlanModel[]; account?: string | null; fallback?: boolean }>;
export type TokenPlanRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;

const uuid = z.uuid();
const tokenFormats: Record<TokenPlanProvider, RegExp> = {
  // `claude setup-token` prints an OAuth token; a Claude API key is not a plan and belongs under API keys.
  claude: /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}$/,
  // OAuth, GitHub App user and fine-grained tokens. Classic personal access tokens cannot use Copilot.
  copilot: /^(gho_|ghu_|github_pat_)[A-Za-z0-9_]{20,500}$/,
};
const attemptMinutes = 15;
const modelsMaxAgeMs = 60 * 60_000;
// Fallback models are dated back so the plan's own list is fetched again after this long, not after an hour.
const fallbackRetryMs = 5 * 60_000;
const fetchedAgoSeconds = (fallback: boolean | undefined) => (fallback ? (modelsMaxAgeMs - fallbackRetryMs) / 1000 : 0);
const deviceCodeEndpoint = 'https://github.com/login/device/code';
const deviceTokenEndpoint = 'https://github.com/login/oauth/access_token';
const deviceVerificationUri = 'https://github.com/login/device';
const clientIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const connectionRow = z.object({
  id: z.uuid(),
  owner_membership_id: z.uuid(),
  generation: z.number().int().positive(),
  state: z.enum(['connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  email: z.string().nullable(),
  credential: z.unknown(),
  models: z.unknown(),
  models_fetched_at: z.date().nullable(),
  github_account_id: z.uuid().nullable(),
  account_state: z.string().nullable(),
  account_login: z.string().nullable(),
  account_expired: z.boolean().nullable(),
  created_at: z.date(),
});
type ConnectionRow = z.infer<typeof connectionRow>;
const attemptRow = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  client_id: z.string(),
  secret: z.unknown(),
  status: z.enum(['pending', 'exchanging', 'completed', 'failed']),
  error_code: z.string().nullable(),
  expires_at: z.date(),
  connection_id: z.uuid().nullish(),
});
const storedModels = z.array(z.object({ slug: z.string(), label: z.string() })).max(200);
// A GitHub App's sign-in also returns a refresh token; its access token expires after a few hours.
const credentialSchema = z.object({
  token: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
});
type Credential = z.infer<typeof credentialSchema>;
const renewMarginMs = 30 * 60_000;
const deviceSecretSchema = z.object({ deviceCode: z.string(), interval: z.number(), polledAt: z.number() });
const deviceCodeResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1).max(32),
  verification_uri: z.url().optional(),
  expires_in: z.coerce.number().int().positive(),
  interval: z.coerce.number().int().positive().optional(),
});
const deviceTokenResponse = z.union([
  z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      expires_in: z.coerce.number().int().positive().optional(),
    })
    .loose(),
  z.object({ error: z.string(), interval: z.coerce.number().int().positive().optional() }).loose(),
]);
const renewedToken = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

/**
 * The GitHub app members sign in to Copilot with: a dedicated OAuth app when one is set, otherwise the GitHub App the
 * integrations use, whose client secret renews its expiring tokens.
 */
export function copilotGitHubClient(env: NodeJS.ProcessEnv = process.env) {
  if (env.COPILOT_GITHUB_CLIENT_ID) return { githubClientId: env.COPILOT_GITHUB_CLIENT_ID };
  if (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET)
    return { githubClientId: env.GITHUB_OAUTH_CLIENT_ID, githubClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET };
  return {};
}

// Claude Code's own sign-in. Claude's callback page shows `code#state` for the member to copy back.
const claudeClientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const claudeAuthorizeEndpoint = 'https://claude.com/cai/oauth/authorize';
const claudeTokenEndpoint = 'https://platform.claude.com/v1/oauth/token';
const claudeRedirectUri = 'https://platform.claude.com/oauth/code/callback';
const claudeAttemptMinutes = 10;
// The same one-year, inference-only token `claude setup-token` prints.
const claudeTokenSeconds = 31_536_000;
const claudeSecretSchema = z.object({ verifier: z.string(), state: z.string() });
const claudeTokenResponse = z.object({ access_token: z.string().min(1) }).loose();
const pastedCode = /^[A-Za-z0-9._~-]{1,2000}$/;

/** The code and, when present, the state from what a member pasted: `code#state`, a bare code, or a callback URL. */
export function parseClaudeCode(input: string): { code: string; state: string | null } | null {
  const trimmed = input.replace(/\s+/g, '');
  let code: string | null = trimmed;
  let state: string | null = null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      code = url.searchParams.get('code');
      state = url.searchParams.get('state') ?? (url.hash.length > 1 ? url.hash.slice(1) : null);
    } catch {
      return null;
    }
  } else if (trimmed.includes('#')) [code = null, state = null] = trimmed.split('#', 2);
  if (!code || !pastedCode.test(code) || (state !== null && state !== '' && !pastedCode.test(state))) return null;
  return { code, state: state || null };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function createTokenPlan(options: {
  provider: TokenPlanProvider;
  runtime: TokenPlanRuntime;
  keyring: IntegrationKeyring;
  verify: TokenPlanVerifier;
  /** The GitHub OAuth app that runs the Copilot device sign-in; without it, members paste a token. */
  githubClientId?: string;
  /** Renews tokens from a GitHub App sign-in, which expire; an OAuth app's tokens don't. */
  githubClientSecret?: string;
  /**
   * For Copilot: reads the current token of a member's personal GitHub account, renewing it when needed. It throws a
   * `TokenPlanError` with `reconnect-required` when the account needs signing in again.
   */
  githubAccountToken?: (workspaceId: string, membershipId: string, accountId: string) => Promise<string>;
  fetcher?: typeof fetch;
}) {
  const { provider } = options;
  const failure = (code: TokenPlanErrorCode) => new TokenPlanError(provider, code);
  const cipher = planTokenCipher(options.keyring, `${provider}-plan`, () => failure('unavailable'));
  const fetcher = options.fetcher ?? fetch;
  const githubClientId =
    provider === 'copilot' && options.githubClientId ? clientIdSchema.parse(options.githubClientId) : null;
  const credentialBinding = (workspaceId: string, row: Pick<ConnectionRow, 'owner_membership_id' | 'generation'>) =>
    ['credential', workspaceId, row.owner_membership_id, row.generation] as const;
  const attemptBinding = (workspaceId: string, attempt: { id: string; membership_id: string }) =>
    ['attempt', workspaceId, attempt.membership_id, attempt.id] as const;
  const table = (tx: AuthorizationTransaction, name: 'connections' | 'connection_attempts') =>
    qualified(tx.schema, `tf_subscription_${name}`);

  async function authorized<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
    mode: 'read' | 'write' = 'read',
  ) {
    return options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      const actor = await lockAndResolveHuman(tx, userId, mode);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }

  const selectConnection = (tx: AuthorizationTransaction) =>
    `SELECT c.id,c.owner_membership_id,c.generation,c.state,c.email,c.credential,c.models,c.models_fetched_at,c.github_account_id,c.created_at,
        a.state AS account_state,a.identity->>'login' AS account_login,COALESCE(a.expires_at<=clock_timestamp(),false) AS account_expired
      FROM ${table(tx, 'connections')} c LEFT JOIN ${qualified(tx.schema, 'tf_github_accounts')} a ON a.id=c.github_account_id`;

  /** One connection of this provider by id, optionally only when `membershipId` owns it. */
  async function loadConnection(
    tx: AuthorizationTransaction,
    connectionId: string,
    membershipId: string | null,
    lock = false,
  ) {
    return connectionRow
      .optional()
      .parse(
        (
          await tx.client.query(
            `${selectConnection(tx)} WHERE c.id=$1 AND c.provider=$2 AND ($3::uuid IS NULL OR c.owner_membership_id=$3::uuid) ${lock ? 'FOR UPDATE OF c' : ''}`,
            [uuid.parse(connectionId), provider, membershipId],
          )
        ).rows[0],
      );
  }

  /** The member's connections of this provider, oldest first, including signed-out ones. */
  async function loadConnections(tx: AuthorizationTransaction, membershipId: string, lock = false) {
    return (
      await tx.client.query(
        `${selectConnection(tx)} WHERE c.owner_membership_id=$1 AND c.provider=$2 ORDER BY c.created_at, c.id ${lock ? 'FOR UPDATE OF c' : ''}`,
        [membershipId, provider],
      )
    ).rows.map(row => connectionRow.parse(row));
  }

  /** A connection that uses a personal GitHub account follows that account: signed out with it, reconnecting with it. */
  function effectiveState(row: ConnectionRow): ConnectionRow['state'] {
    if (!row.github_account_id || row.state !== 'connected') return row.state;
    if (row.account_state === 'disconnected' || row.account_state === null) return 'signed-out';
    if (row.account_state !== 'active' || row.account_expired) return 'reconnect-required';
    return 'connected';
  }

  function statusOf(row: ConnectionRow): TokenPlanStatus {
    const state = effectiveState(row);
    const planUsage = state === 'connected';
    return {
      connectionId: row.id,
      state: state === 'plan-disabled' ? 'reconnect-required' : state,
      account: row.account_login ?? row.email,
      ...(row.github_account_id ? { githubAccountId: row.github_account_id } : {}),
      planUsage,
      models: planUsage ? (storedModels.safeParse(row.models).data ?? []) : [],
      createdAt: row.created_at.toISOString(),
    };
  }

  async function verified(token: string) {
    const checked = await options.verify(token).catch((error: unknown) => {
      if (error instanceof TokenPlanError) throw failure(error.code);
      throw failure('unavailable');
    });
    const models = storedModels.parse(
      checked.models.filter(model => model.slug.length <= 200 && model.label.length <= 200).slice(0, 200),
    );
    // A Copilot token that lists no models can't run anything, most often because the account has no Copilot plan.
    if (provider === 'copilot' && !models.length) throw failure('not-eligible');
    const account = checked.account && checked.account.length <= 320 ? checked.account : null;
    return { models, account, fallback: checked.fallback === true };
  }

  /**
   * Verifies `token` and stores it, starting a new credential generation. It replaces the sign-in of `target`, or of
   * the member's connection with the same GitHub account or vendor account, and otherwise adds a connection. With
   * `githubAccountId`, the connection uses that personal GitHub account and stores no token of its own. Returns the
   * connection's id.
   */
  async function store(
    workspaceId: string,
    membershipId: string,
    token: string,
    renewal?: Omit<Credential, 'token'>,
    githubAccountId: string | null = null,
    target: string | null = null,
  ) {
    const { models, account, fallback } = await verified(token);
    const saved = await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      const rows = await loadConnections(tx, membershipId, true);
      const accounts = hasPlanAccounts(tx);
      // Live connections come first, so a match revives a signed-out one only when no live one matches.
      const ordered = [...rows].sort((a, b) => Number(a.state === 'signed-out') - Number(b.state === 'signed-out'));
      let row: ConnectionRow | undefined;
      if (target) {
        row = rows.find(item => item.id === target);
        if (!row || row.state === 'signed-out') return { error: 'not-connected' as const };
      } else if (!accounts) row = rows[0];
      else
        row =
          (githubAccountId ? ordered.find(item => item.github_account_id === githubAccountId) : undefined) ??
          (account ? ordered.find(item => (item.account_login ?? item.email) === account) : undefined);
      if (!row && accounts && rows.filter(item => item.state !== 'signed-out').length >= maxPlanAccounts)
        return { error: 'too-many-accounts' as const };
      const id = row?.id ?? randomUUID();
      const generation = row ? row.generation + 1 : await nextGeneration(tx, membershipId, provider);
      const binding = credentialBinding(workspaceId, { owner_membership_id: membershipId, generation });
      const credential = githubAccountId ? null : cipher.encrypt(binding, { token, ...renewal });
      if (row)
        await tx.client.query(
          `UPDATE ${table(tx, 'connections')} SET generation=$2,state='connected',email=$3,credential=$4,models=$5,github_account_id=$6,models_fetched_at=clock_timestamp()-make_interval(secs=>$7),cooldown_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,
          [id, generation, account, credential, JSON.stringify(models), githubAccountId, fetchedAgoSeconds(fallback)],
        );
      else
        await tx.client.query(
          `INSERT INTO ${table(tx, 'connections')} (id,provider,owner_membership_id,generation,state,email,credential,models,github_account_id,models_fetched_at) VALUES ($1,$2,$3,$4,'connected',$5,$6,$7,$8,clock_timestamp()-make_interval(secs=>$9))`,
          [
            id,
            provider,
            membershipId,
            generation,
            account,
            credential,
            JSON.stringify(models),
            githubAccountId,
            fetchedAgoSeconds(fallback),
          ],
        );
      return { id };
    });
    if ('error' in saved) throw failure(saved.error);
    return saved.id;
  }

  async function accountToken(workspaceId: string, membershipId: string, accountId: string) {
    if (!options.githubAccountToken) throw failure('unavailable');
    return options.githubAccountToken(workspaceId, membershipId, accountId).catch((error: unknown) => {
      if (error instanceof TokenPlanError) throw failure(error.code);
      throw failure('unavailable');
    });
  }

  const stale = (credential: Credential) =>
    credential.expiresAt !== undefined && credential.expiresAt <= Date.now() + renewMarginMs;

  async function storedToken(
    workspaceId: string,
    connectionId: string,
    renew = false,
  ): Promise<{ token: string; row: ConnectionRow }> {
    const outcome = await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      // A refresh token is single-use, so a renewal holds the row lock and checks again whether it is still needed.
      const row = await loadConnection(tx, connectionId, null, renew);
      const state = row && effectiveState(row);
      if (!row || state === 'signed-out') return { error: 'not-connected' as const };
      if (state !== 'connected') return { error: 'reconnect-required' as const };
      if (row.github_account_id) return { account: row.github_account_id, row };
      const binding = credentialBinding(workspaceId, row);
      const credential = cipher.decrypt(binding, row.credential, credentialSchema);
      if (!stale(credential)) return { token: credential.token, row };
      if (!renew) return { renew: true as const };
      const renewed =
        credential.refreshToken && githubClientId && options.githubClientSecret
          ? renewedToken.safeParse(
              await githubJson(deviceTokenEndpoint, {
                client_id: githubClientId,
                client_secret: options.githubClientSecret,
                grant_type: 'refresh_token',
                refresh_token: credential.refreshToken,
              }),
            )
          : null;
      // GitHub answers a spent or revoked refresh token with HTTP 200 and an `error` field.
      if (!renewed?.success) {
        await tx.client.query(
          `UPDATE ${table(tx, 'connections')} SET state='reconnect-required',credential=NULL,updated_at=clock_timestamp() WHERE id=$1`,
          [row.id],
        );
        return { error: 'reconnect-required' as const };
      }
      const token = renewed.data.access_token;
      await tx.client.query(
        `UPDATE ${table(tx, 'connections')} SET credential=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [
          row.id,
          cipher.encrypt(binding, {
            token,
            refreshToken: renewed.data.refresh_token,
            expiresAt: Date.now() + renewed.data.expires_in * 1000,
          }),
        ],
      );
      return { token, row };
    });
    if ('error' in outcome) throw failure(outcome.error);
    if ('renew' in outcome) return storedToken(workspaceId, connectionId, true);
    if ('account' in outcome)
      return {
        token: await accountToken(workspaceId, outcome.row.owner_membership_id, outcome.account),
        row: outcome.row,
      };
    return outcome;
  }

  async function markReconnect(workspaceId: string, connectionId: string) {
    await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'connections')} SET state='reconnect-required',credential=NULL,updated_at=clock_timestamp() WHERE id=$1 AND provider=$2 AND state='connected'`,
        [uuid.parse(connectionId), provider],
      );
    });
  }

  /** Fetches the plan's models again. While the vendor can't list them, the last list it gave stays. */
  async function refreshModels(workspaceId: string, connectionId: string, current: TokenPlanModel[]) {
    const { token } = await storedToken(workspaceId, connectionId);
    let models: TokenPlanModel[];
    let fallback: boolean;
    try {
      ({ models, fallback } = await verified(token));
    } catch (error) {
      if (error instanceof TokenPlanError && error.code === 'token-rejected')
        await markReconnect(workspaceId, connectionId);
      throw error;
    }
    if (fallback && current.length) models = current;
    await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'connections')} SET models=$2,models_fetched_at=clock_timestamp()-make_interval(secs=>$3) WHERE id=$1 AND state='connected'`,
        [connectionId, JSON.stringify(models), fetchedAgoSeconds(fallback)],
      );
    });
    return models;
  }

  async function githubJson(url: string, body: Record<string, string>) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw failure('unavailable');
    }
    if (response.status === 429) throw failure('rate-limited');
    if (!response.ok) throw failure(response.status >= 500 ? 'unavailable' : 'authorization-failed');
    return (await response.json().catch(() => null)) as unknown;
  }

  async function closeAttempt(workspaceId: string, attemptId: string, status: 'completed' | 'failed', code?: string) {
    await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'connection_attempts')} SET status=$2,secret=NULL,error_code=$3 WHERE id=$1 AND status IN ('pending','exchanging')`,
        [attemptId, status, status === 'failed' ? code : null],
      );
    });
  }

  async function liveCount(tx: AuthorizationTransaction, membershipId: string) {
    return (await loadConnections(tx, membershipId)).filter(row => effectiveState(row) !== 'signed-out').length;
  }

  async function limitAttempts(tx: AuthorizationTransaction, membershipId: string) {
    const recent = await tx.client.query(
      `SELECT count(*)::integer AS count FROM ${table(tx, 'connection_attempts')} WHERE membership_id=$1 AND provider=$2 AND created_at>clock_timestamp()-interval '10 minutes'`,
      [membershipId, provider],
    );
    if (Number((recent.rows[0] as { count: number }).count) >= 20) throw failure('rate-limited');
  }

  const service = {
    provider,
    /** Whether members can sign in through GitHub instead of pasting a token. */
    deviceSignIn: githubClientId !== null,

    /** The member's signed-in connections of this provider, oldest first. */
    async status(workspaceId: string, userId: string): Promise<{ connections: TokenPlanStatus[] }> {
      const rows = await authorized(workspaceId, userId, async (tx, actor) =>
        (await loadConnections(tx, actor.membershipId)).filter(row => effectiveState(row) !== 'signed-out'),
      );
      const connections = await Promise.all(
        rows.map(async row => {
          const status = statusOf(row);
          const stale =
            effectiveState(row) === 'connected' &&
            (!row.models_fetched_at || Date.now() - row.models_fetched_at.getTime() > modelsMaxAgeMs);
          if (!stale) return status;
          try {
            return { ...status, models: await refreshModels(workspaceId, row.id, status.models) };
          } catch (error) {
            if (error instanceof TokenPlanError && error.code !== 'unavailable' && error.code !== 'rate-limited') {
              const fresh = await authorized(workspaceId, userId, tx => loadConnection(tx, row.id, null));
              return fresh ? statusOf(fresh) : status;
            }
            return status;
          }
        }),
      );
      return { connections };
    },

    /**
     * Connects the member with a token they pasted. The token never leaves the server again. With `connectionId`, it
     * replaces that connection's sign-in; otherwise it adds an account or replaces the one with the same account.
     */
    async connectToken(workspaceId: string, userId: string, token: string, connectionId?: string) {
      // Terminals wrap a long token across lines, so a pasted token keeps no whitespace.
      const trimmed = token.replace(/\s+/g, '');
      if (!tokenFormats[provider].test(trimmed)) throw failure('token-invalid');
      const membershipId = await authorized(workspaceId, userId, async (_tx, actor) => actor.membershipId, 'write');
      await store(workspaceId, membershipId, trimmed, undefined, null, connectionId ? uuid.parse(connectionId) : null);
      return service.status(workspaceId, userId);
    },

    /**
     * Starts Claude Code's sign-in for Claude. The member approves TulipFarm at `authorizeUrl` in a new tab, then pastes
     * the code Claude shows into `completeSignIn`. With `connectionId`, it reconnects that connection.
     */
    async beginSignIn(workspaceId: string, userId: string, connectionId?: string) {
      if (provider !== 'claude') throw failure('unavailable');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const attemptId = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          await limitAttempts(tx, actor.membershipId);
          const accounts = hasPlanAccounts(tx);
          const target = connectionId ? await loadConnection(tx, connectionId, actor.membershipId) : undefined;
          if (connectionId && (!target || target.state === 'signed-out')) throw failure('not-connected');
          if (!target && accounts && (await liveCount(tx, actor.membershipId)) >= maxPlanAccounts)
            throw failure('too-many-accounts');
          const id = randomUUID();
          await tx.client.query(
            `INSERT INTO ${table(tx, 'connection_attempts')} (id,provider,membership_id,state_hash,mode,client_id,redirect_uri,secret,status,expires_at${accounts ? ',connection_id' : ''})
             VALUES ($1,'claude',$2,$3,$4,$5,$6,$7,'pending',clock_timestamp()+$8*interval '1 minute'${accounts ? ',$9' : ''})`,
            [
              id,
              actor.membershipId,
              sha256(state),
              target ? 'reconnect' : 'connect',
              claudeClientId,
              claudeRedirectUri,
              cipher.encrypt(attemptBinding(workspaceId, { id, membership_id: actor.membershipId }), {
                verifier,
                state,
              }),
              claudeAttemptMinutes,
              ...(accounts ? [target?.id ?? null] : []),
            ],
          );
          return id;
        },
        'write',
      );
      const url = new URL(claudeAuthorizeEndpoint);
      url.searchParams.set('code', 'true');
      url.searchParams.set('client_id', claudeClientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', claudeRedirectUri);
      url.searchParams.set('scope', 'user:inference');
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      return { attemptId, authorizeUrl: url.toString(), expiresInSeconds: claudeAttemptMinutes * 60 };
    },

    /**
     * Finishes a Claude sign-in with what the member pasted: `code#state`, a bare code for their latest sign-in, or the
     * callback URL. Each sign-in can be used once.
     */
    async completeSignIn(workspaceId: string, userId: string, input: string) {
      if (provider !== 'claude') throw failure('unavailable');
      const pasted = parseClaudeCode(input);
      if (!pasted) throw failure('code-invalid');
      const claimed = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const found = attemptRow
            .optional()
            .parse(
              (
                await tx.client.query(
                  pasted.state
                    ? `SELECT * FROM ${table(tx, 'connection_attempts')} WHERE state_hash=$1 AND provider='claude' FOR UPDATE`
                    : `SELECT * FROM ${table(tx, 'connection_attempts')} WHERE membership_id=$1 AND provider='claude' AND status='pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
                  [pasted.state ? sha256(pasted.state) : actor.membershipId],
                )
              ).rows[0],
            );
          if (!found || found.membership_id !== actor.membershipId) return { error: 'attempt-not-found' as const };
          if (found.status !== 'pending') return { error: 'attempt-not-found' as const };
          if (found.expires_at.getTime() <= Date.now()) {
            await tx.client.query(
              `UPDATE ${table(tx, 'connection_attempts')} SET status='failed',secret=NULL,error_code='attempt-expired' WHERE id=$1`,
              [found.id],
            );
            return { error: 'attempt-expired' as const };
          }
          const secret = cipher.decrypt(attemptBinding(workspaceId, found), found.secret, claudeSecretSchema);
          await tx.client.query(
            `UPDATE ${table(tx, 'connection_attempts')} SET status='exchanging',secret=NULL WHERE id=$1`,
            [found.id],
          );
          return { attempt: found, secret, membershipId: actor.membershipId };
        },
        'write',
      );
      if ('error' in claimed) throw failure(claimed.error);
      const { attempt, secret, membershipId } = claimed;
      try {
        let response: Response;
        try {
          response = await fetcher(claudeTokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              code: pasted.code,
              redirect_uri: claudeRedirectUri,
              client_id: claudeClientId,
              code_verifier: secret.verifier,
              state: secret.state,
              expires_in: claudeTokenSeconds,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          throw failure('unavailable');
        }
        if (response.status === 429) throw failure('rate-limited');
        if (response.status >= 500) throw failure('unavailable');
        // Claude answers a wrong, used or expired code with a 4xx.
        const token = claudeTokenResponse.safeParse(response.ok ? await response.json().catch(() => null) : null);
        if (!token.success || !tokenFormats.claude.test(token.data.access_token)) throw failure('authorization-failed');
        await store(workspaceId, membershipId, token.data.access_token, undefined, null, attempt.connection_id ?? null);
      } catch (error) {
        await closeAttempt(
          workspaceId,
          attempt.id,
          'failed',
          error instanceof TokenPlanError ? error.code : 'unavailable',
        );
        throw error;
      }
      await closeAttempt(workspaceId, attempt.id, 'completed');
      return service.status(workspaceId, userId);
    },

    /** Starts a GitHub device sign-in for Copilot. The member enters `userCode` at `verificationUri`. */
    async beginDevice(workspaceId: string, userId: string, connectionId?: string) {
      if (!githubClientId) throw failure('device-sign-in-unavailable');
      const started = deviceCodeResponse.safeParse(
        await githubJson(deviceCodeEndpoint, { client_id: githubClientId, scope: 'read:user' }),
      );
      if (!started.success) throw failure('authorization-failed');
      const { device_code, user_code, expires_in, interval = 5 } = started.data;
      const expiresInSeconds = Math.min(expires_in, attemptMinutes * 60);
      return authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const accounts = hasPlanAccounts(tx);
          const target = connectionId ? await loadConnection(tx, connectionId, actor.membershipId) : undefined;
          if (connectionId && (!target || target.state === 'signed-out')) throw failure('not-connected');
          if (!target && accounts && (await liveCount(tx, actor.membershipId)) >= maxPlanAccounts)
            throw failure('too-many-accounts');
          const id = randomUUID();
          const secret = cipher.encrypt(attemptBinding(workspaceId, { id, membership_id: actor.membershipId }), {
            deviceCode: device_code,
            interval,
            polledAt: 0,
          });
          await tx.client.query(
            `INSERT INTO ${table(tx, 'connection_attempts')} (id,provider,membership_id,state_hash,mode,client_id,redirect_uri,secret,status,expires_at${accounts ? ',connection_id' : ''}) VALUES ($1,$2,$3,$4,$9,$5,$6,$7,'pending',clock_timestamp()+$8*interval '1 second'${accounts ? ',$10' : ''})`,
            [
              id,
              provider,
              actor.membershipId,
              sha256(randomBytes(32).toString('base64url')),
              githubClientId,
              deviceVerificationUri,
              secret,
              expiresInSeconds,
              target ? 'reconnect' : 'connect',
              ...(accounts ? [target?.id ?? null] : []),
            ],
          );
          return {
            attemptId: id,
            userCode: user_code,
            verificationUri: deviceVerificationUri,
            intervalSeconds: interval,
            expiresInSeconds,
          };
        },
        'write',
      );
    },

    /**
     * The state of a device sign-in. While it is pending, each read asks GitHub once, at most as often as GitHub
     * allows, and finishes the connection when the member has approved it.
     */
    async attempt(workspaceId: string, userId: string, attemptId: string): Promise<TokenPlanAttemptStatus> {
      const claimed = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const row = attemptRow
            .optional()
            .parse(
              (
                await tx.client.query(
                  `SELECT * FROM ${table(tx, 'connection_attempts')} WHERE id=$1 AND provider=$2 FOR UPDATE`,
                  [uuid.parse(attemptId), provider],
                )
              ).rows[0],
            );
          if (!row || row.membership_id !== actor.membershipId) throw failure('attempt-not-found');
          if (row.status !== 'pending')
            return {
              done: {
                status: row.status === 'exchanging' ? 'pending' : row.status,
                errorCode: row.error_code,
              } as TokenPlanAttemptStatus,
            };
          if (row.expires_at.getTime() <= Date.now()) {
            await tx.client.query(
              `UPDATE ${table(tx, 'connection_attempts')} SET status='failed',secret=NULL,error_code='attempt-expired' WHERE id=$1`,
              [row.id],
            );
            return { done: { status: 'failed', errorCode: 'attempt-expired' } as TokenPlanAttemptStatus };
          }
          const binding = attemptBinding(workspaceId, row);
          const secret = cipher.decrypt(binding, row.secret, deviceSecretSchema);
          if (Date.now() - secret.polledAt < secret.interval * 1000)
            return { done: { status: 'pending', errorCode: null } as TokenPlanAttemptStatus };
          await tx.client.query(`UPDATE ${table(tx, 'connection_attempts')} SET secret=$2 WHERE id=$1`, [
            row.id,
            cipher.encrypt(binding, { ...secret, polledAt: Date.now() }),
          ]);
          return {
            poll: {
              secret,
              binding,
              membershipId: actor.membershipId,
              clientId: row.client_id,
              target: row.connection_id ?? null,
            },
          };
        },
        'write',
      );
      if ('done' in claimed) return claimed.done;
      const { secret, binding, membershipId, clientId, target } = claimed.poll;
      const polled = deviceTokenResponse.safeParse(
        await githubJson(deviceTokenEndpoint, {
          client_id: clientId,
          device_code: secret.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      );
      if (!polled.success) throw failure('authorization-failed');
      if ('error' in polled.data) {
        const { error, interval } = polled.data;
        if (error === 'authorization_pending' || error === 'slow_down') {
          if (error === 'slow_down')
            await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
              await tx.client.query(
                `UPDATE ${table(tx, 'connection_attempts')} SET secret=$2 WHERE id=$1 AND status='pending'`,
                [
                  attemptId,
                  cipher.encrypt(binding, {
                    ...secret,
                    interval: interval ?? secret.interval + 5,
                    polledAt: Date.now(),
                  }),
                ],
              );
            });
          return { status: 'pending', errorCode: null };
        }
        const code: TokenPlanErrorCode =
          error === 'expired_token'
            ? 'attempt-expired'
            : error === 'access_denied'
              ? 'authorization-declined'
              : 'authorization-failed';
        await closeAttempt(workspaceId, attemptId, 'failed', code);
        return { status: 'failed', errorCode: code };
      }
      try {
        const { access_token, refresh_token, expires_in } = polled.data;
        await store(
          workspaceId,
          membershipId,
          access_token,
          refresh_token && expires_in
            ? { refreshToken: refresh_token, expiresAt: Date.now() + expires_in * 1000 }
            : undefined,
          null,
          target,
        );
      } catch (error) {
        const code = error instanceof TokenPlanError ? error.code : 'unavailable';
        await closeAttempt(workspaceId, attemptId, 'failed', code);
        return { status: 'failed', errorCode: code };
      }
      await closeAttempt(workspaceId, attemptId, 'completed');
      return { status: 'completed', errorCode: null };
    },

    /**
     * Connects Copilot with the member's personal GitHub account `accountId`, sharing its sign-in, as its own Copilot
     * connection. With `onlyIfFree`, it adds nothing when the member already has a working Copilot connection of
     * another credential or has no room for another, and reports whether it connected.
     */
    async useGitHubAccount(workspaceId: string, userId: string, accountId: string, onlyIfFree = false) {
      if (provider !== 'copilot') throw failure('unavailable');
      const { membershipId, free } = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const rows = (await loadConnections(tx, actor.membershipId)).filter(
            row => effectiveState(row) !== 'signed-out',
          );
          const own = rows.some(row => row.github_account_id === uuid.parse(accountId));
          const working = rows.some(row => effectiveState(row) === 'connected');
          return {
            membershipId: actor.membershipId,
            free: own || (!working && (!hasPlanAccounts(tx) || rows.length < maxPlanAccounts)),
          };
        },
        'write',
      );
      if (onlyIfFree && !free) return false;
      await store(
        workspaceId,
        membershipId,
        await accountToken(workspaceId, membershipId, accountId),
        undefined,
        accountId,
      );
      return true;
    },

    /**
     * Clears one connection's stored token and ends its shares; connecting that account later starts private again.
     * Its chat and coding choices stay, but a signed-out connection is not used.
     */
    async disconnect(workspaceId: string, userId: string, connectionId: string) {
      await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const row = await loadConnection(tx, connectionId, null, true);
          if (!row) throw failure('not-connected');
          if (row.owner_membership_id !== actor.membershipId) throw new AccessDenied();
          await tx.client.query(
            `UPDATE ${table(tx, 'connections')} SET state='signed-out',credential=NULL,github_account_id=NULL,expires_at=NULL,models=NULL,models_fetched_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,
            [row.id],
          );
          await tx.client.query(
            `DELETE FROM ${qualified(tx.schema, 'tf_subscription_grants')} WHERE connection_id=$1`,
            [row.id],
          );
        },
        'write',
      );
      // Neither vendor offers a revocation endpoint for these tokens; the member revokes them with the vendor.
      return { revoked: false };
    },

    /** The model slugs a member may pick on their own plan, or an empty list when they can't use it. */
    async memberModels(workspaceId: string, userId: string) {
      try {
        const { connections } = await service.status(workspaceId, userId);
        return [
          ...new Set(connections.flatMap(status => (status.planUsage ? status.models.map(model => model.slug) : []))),
        ];
      } catch (error) {
        if (error instanceof AccessDenied || error instanceof TokenPlanError) return [];
        throw error;
      }
    },

    /** For a reply worker: the stored token of one connection. */
    async accessToken(workspaceId: string, connectionId: string) {
      return (await storedToken(workspaceId, uuid.parse(connectionId))).token;
    },

    /** Marks a connection whose token the vendor rejected so the owner is asked to connect again. */
    requireReconnect: markReconnect,
  };
  return service;
}
export type TokenPlan = ReturnType<typeof createTokenPlan>;
