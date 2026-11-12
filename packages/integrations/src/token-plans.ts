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
import { commonCompatibility, qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import type { IntegrationKeyring } from './credentials.ts';
import { planTokenCipher } from './plan-cipher.ts';

/**
 * Claude and GitHub Copilot plans. Neither offers a web sign-in a third party can use, so a member connects with a
 * long-lived token: a Claude setup token from `claude setup-token`, or a GitHub token from the device sign-in below or
 * one they paste. The token is checked with the vendor, encrypted, and stored on the member's connection.
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
  state: 'not-connected' | 'connected' | 'reconnect-required' | 'signed-out';
  /** The account the token belongs to when the vendor names it, such as a GitHub login. */
  account: string | null;
  /** For Copilot, the personal GitHub account the connection uses instead of a token of its own. */
  githubAccountId?: string | null;
  planUsage: boolean;
  models: TokenPlanModel[];
};
export type TokenPlanAttemptStatus = { status: 'pending' | 'completed' | 'failed'; errorCode: string | null };
/**
 * Checks a token with the vendor and returns the models it may use and the account it belongs to. It throws a
 * `TokenPlanError` with `token-rejected`, `not-eligible`, `rate-limited` or `unavailable`. A plan that has reached its
 * usage limit still connects: `verify` returns normally for it.
 */
export type TokenPlanVerifier = (token: string) => Promise<{ models: TokenPlanModel[]; account?: string | null }>;
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
      await lockAuthorization(tx, mode);
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }

  async function loadConnection(tx: AuthorizationTransaction, membershipId: string, lock = false) {
    return connectionRow.optional().parse(
      (
        await tx.client.query(
          `SELECT c.id,c.owner_membership_id,c.generation,c.state,c.email,c.credential,c.models,c.models_fetched_at,c.github_account_id,
              a.state AS account_state,a.identity->>'login' AS account_login,COALESCE(a.expires_at<=clock_timestamp(),false) AS account_expired
            FROM ${table(tx, 'connections')} c LEFT JOIN ${qualified(tx.schema, 'tf_github_accounts')} a ON a.id=c.github_account_id
            WHERE c.owner_membership_id=$1 AND c.provider=$2 ${lock ? 'FOR UPDATE OF c' : ''}`,
          [membershipId, provider],
        )
      ).rows[0],
    );
  }

  /** A connection that uses a personal GitHub account follows that account: signed out with it, reconnecting with it. */
  function effectiveState(row: ConnectionRow): ConnectionRow['state'] {
    if (!row.github_account_id || row.state !== 'connected') return row.state;
    if (row.account_state === 'disconnected' || row.account_state === null) return 'signed-out';
    if (row.account_state !== 'active' || row.account_expired) return 'reconnect-required';
    return 'connected';
  }

  function statusOf(row: ConnectionRow | undefined): TokenPlanStatus {
    if (!row) return { state: 'not-connected', account: null, planUsage: false, models: [] };
    const state = effectiveState(row);
    const planUsage = state === 'connected';
    return {
      state: state === 'plan-disabled' ? 'reconnect-required' : state,
      account: row.account_login ?? row.email,
      ...(row.github_account_id ? { githubAccountId: row.github_account_id } : {}),
      planUsage,
      models: planUsage ? (storedModels.safeParse(row.models).data ?? []) : [],
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
    return { models, account };
  }

  /**
   * Verifies `token` and stores it as the member's connection, starting a new credential generation. With
   * `githubAccountId`, the connection uses that personal GitHub account and stores no token of its own.
   */
  async function store(
    workspaceId: string,
    membershipId: string,
    token: string,
    renewal?: Omit<Credential, 'token'>,
    githubAccountId: string | null = null,
  ) {
    const { models, account } = await verified(token);
    await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      const row = await loadConnection(tx, membershipId, true);
      const generation = row ? row.generation + 1 : 1;
      const binding = credentialBinding(workspaceId, { owner_membership_id: membershipId, generation });
      const credential = githubAccountId ? null : cipher.encrypt(binding, { token, ...renewal });
      if (row)
        await tx.client.query(
          `UPDATE ${table(tx, 'connections')} SET generation=$3,state='connected',email=$4,credential=$5,models=$6,github_account_id=$7,models_fetched_at=clock_timestamp(),cooldown_until=NULL,updated_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider=$2`,
          [membershipId, provider, generation, account, credential, JSON.stringify(models), githubAccountId],
        );
      else
        await tx.client.query(
          `INSERT INTO ${table(tx, 'connections')} (id,provider,owner_membership_id,generation,state,email,credential,models,github_account_id,models_fetched_at) VALUES ($1,$2,$3,$4,'connected',$5,$6,$7,$8,clock_timestamp())`,
          [
            randomUUID(),
            provider,
            membershipId,
            generation,
            account,
            credential,
            JSON.stringify(models),
            githubAccountId,
          ],
        );
    });
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

  async function storedToken(workspaceId: string, membershipId: string, renew = false) {
    const outcome = await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      // A refresh token is single-use, so a renewal holds the row lock and checks again whether it is still needed.
      const row = await loadConnection(tx, membershipId, renew);
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
    if ('renew' in outcome) return storedToken(workspaceId, membershipId, true);
    if ('account' in outcome)
      return { token: await accountToken(workspaceId, membershipId, outcome.account), row: outcome.row };
    return outcome;
  }

  async function markReconnect(workspaceId: string, membershipId: string) {
    await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'connections')} SET state='reconnect-required',credential=NULL,updated_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider=$2 AND state='connected'`,
        [uuid.parse(membershipId), provider],
      );
    });
  }

  async function refreshModels(workspaceId: string, membershipId: string) {
    const { token } = await storedToken(workspaceId, membershipId);
    let models: TokenPlanModel[];
    try {
      ({ models } = await verified(token));
    } catch (error) {
      if (error instanceof TokenPlanError && error.code === 'token-rejected')
        await markReconnect(workspaceId, membershipId);
      throw error;
    }
    await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'connections')} SET models=$3,models_fetched_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider=$2 AND state='connected'`,
        [membershipId, provider, JSON.stringify(models)],
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

  const service = {
    provider,
    /** Whether members can sign in through GitHub instead of pasting a token. */
    deviceSignIn: githubClientId !== null,

    async status(workspaceId: string, userId: string): Promise<TokenPlanStatus> {
      const { row, membershipId } = await authorized(workspaceId, userId, async (tx, actor) => ({
        row: await loadConnection(tx, actor.membershipId),
        membershipId: actor.membershipId,
      }));
      const status = statusOf(row);
      const stale =
        !!row &&
        effectiveState(row) === 'connected' &&
        (!row.models_fetched_at || Date.now() - row.models_fetched_at.getTime() > modelsMaxAgeMs);
      if (!stale) return status;
      try {
        return { ...status, models: await refreshModels(workspaceId, membershipId) };
      } catch (error) {
        if (error instanceof TokenPlanError && error.code !== 'unavailable' && error.code !== 'rate-limited')
          return statusOf(await authorized(workspaceId, userId, (tx, actor) => loadConnection(tx, actor.membershipId)));
        return status;
      }
    },

    /** Connects the member with a token they pasted. The token never leaves the server again. */
    async connectToken(workspaceId: string, userId: string, token: string) {
      // Terminals wrap a long token across lines, so a pasted token keeps no whitespace.
      const trimmed = token.replace(/\s+/g, '');
      if (!tokenFormats[provider].test(trimmed)) throw failure('token-invalid');
      const membershipId = await authorized(workspaceId, userId, async (_tx, actor) => actor.membershipId, 'write');
      await store(workspaceId, membershipId, trimmed);
      return service.status(workspaceId, userId);
    },

    /** Starts a GitHub device sign-in for Copilot. The member enters `userCode` at `verificationUri`. */
    async beginDevice(workspaceId: string, userId: string) {
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
          const id = randomUUID();
          const secret = cipher.encrypt(attemptBinding(workspaceId, { id, membership_id: actor.membershipId }), {
            deviceCode: device_code,
            interval,
            polledAt: 0,
          });
          await tx.client.query(
            `INSERT INTO ${table(tx, 'connection_attempts')} (id,provider,membership_id,state_hash,mode,client_id,redirect_uri,secret,status,expires_at) VALUES ($1,$2,$3,$4,'connect',$5,$6,$7,'pending',clock_timestamp()+$8*interval '1 second')`,
            [
              id,
              provider,
              actor.membershipId,
              sha256(randomBytes(32).toString('base64url')),
              githubClientId,
              deviceVerificationUri,
              secret,
              expiresInSeconds,
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
                  `SELECT id,membership_id,client_id,secret,status,error_code,expires_at FROM ${table(tx, 'connection_attempts')} WHERE id=$1 AND provider=$2 FOR UPDATE`,
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
          return { poll: { secret, binding, membershipId: actor.membershipId, clientId: row.client_id } };
        },
        'write',
      );
      if ('done' in claimed) return claimed.done;
      const { secret, binding, membershipId, clientId } = claimed.poll;
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
     * Connects Copilot with the member's personal GitHub account `accountId`, sharing its sign-in. With `onlyIfFree`, it
     * leaves a working connection that uses another credential alone and reports whether it connected.
     */
    async useGitHubAccount(workspaceId: string, userId: string, accountId: string, onlyIfFree = false) {
      if (provider !== 'copilot') throw failure('unavailable');
      const { membershipId, free } = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const row = await loadConnection(tx, actor.membershipId);
          const free = !row || effectiveState(row) !== 'connected' || row.github_account_id === uuid.parse(accountId);
          return { membershipId: actor.membershipId, free };
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

    /** Clears the stored token and ends every share; a later connection starts private again. */
    async disconnect(workspaceId: string, userId: string) {
      await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          await tx.client.query(
            `UPDATE ${table(tx, 'connections')} SET state='signed-out',credential=NULL,github_account_id=NULL,expires_at=NULL,models=NULL,models_fetched_at=NULL,updated_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider=$2`,
            [actor.membershipId, provider],
          );
          await tx.client.query(
            `DELETE FROM ${qualified(tx.schema, 'tf_subscription_grants')} WHERE connection_id IN (SELECT id FROM ${table(tx, 'connections')} WHERE owner_membership_id=$1 AND provider=$2)`,
            [actor.membershipId, provider],
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
        const status = await service.status(workspaceId, userId);
        return status.planUsage ? status.models.map(model => model.slug) : [];
      } catch (error) {
        if (error instanceof AccessDenied || error instanceof TokenPlanError) return [];
        throw error;
      }
    },

    /** For a reply worker: the owner's stored token. */
    async accessToken(workspaceId: string, membershipId: string) {
      return (await storedToken(workspaceId, uuid.parse(membershipId))).token;
    },

    /** Marks a connection whose token the vendor rejected so the owner is asked to connect again. */
    requireReconnect: markReconnect,
  };
  return service;
}
export type TokenPlan = ReturnType<typeof createTokenPlan>;
