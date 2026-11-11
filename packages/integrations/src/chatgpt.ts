import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
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

/** Sign in with ChatGPT: each member connects their own ChatGPT account so their own chats can run on their plan. */
export const chatGptIssuer = 'https://auth.openai.com';
export const chatGptUsageUrl = 'https://chatgpt.com/settings/usage';
const authorizeEndpoint = `${chatGptIssuer}/api/accounts/authorize`;
const tokenEndpoint = `${chatGptIssuer}/api/accounts/oauth/token`;
const discoveryEndpoint = `${chatGptIssuer}/.well-known/openid-configuration`;
const resource = 'https://api.openai.com/v1';
const modelsEndpoint = 'https://api.openai.com/v1/models';
const planScope = 'chatgpt.tokens.use.direct';
const requestedScopes = `openid profile email offline_access resource.invoke ${planScope}`;
const dynamicClient = 'dynamic_agent_client';
const attemptMinutes = 10;
const refreshMarginMs = 5 * 60_000;
const modelsMaxAgeMs = 60 * 60_000;
// A refresh that fails with one of these cannot succeed later: the member must sign in again.
const terminalRefreshErrors = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export const chatGptPlanErrorCodes = [
  'attempt-not-found',
  'attempt-expired',
  'authorization-declined',
  'authorization-failed',
  'registration-incomplete',
  'client-mismatch',
  'account-mismatch',
  'code-rejected',
  'exchange-failed',
  'identity-invalid',
  'callback-invalid',
  'not-connected',
  'reconnect-required',
  'plan-disabled',
  'rate-limited',
  'unavailable',
] as const;
export type ChatGptPlanErrorCode = (typeof chatGptPlanErrorCodes)[number];
export class ChatGptPlanError extends Error {
  constructor(readonly code: ChatGptPlanErrorCode) {
    super(`chatgpt-${code}`);
    this.name = 'ChatGptPlanError';
  }
}

export const chatGptConnectionModes = ['connect', 'reconnect', 'enable-plan'] as const;
export type ChatGptConnectionMode = (typeof chatGptConnectionModes)[number];
export type ChatGptConnectionState =
  | 'not-connected'
  | 'connected'
  | 'plan-disabled'
  | 'reconnect-required'
  | 'signed-out';
export type ChatGptModel = { slug: string; label: string };
export type ChatGptConnectionStatus = {
  state: ChatGptConnectionState;
  email: string | null;
  planUsage: boolean;
  welcomePending: boolean;
  models: ChatGptModel[];
};
export type ChatGptAttemptStatus = { status: 'pending' | 'completed' | 'failed'; errorCode: string | null };
export type ChatGptPlanRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;

const uuid = z.uuid();
const redirectPattern = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/auth\/callback$/;
const clientIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const connectionRow = z.object({
  id: z.uuid(),
  owner_membership_id: z.uuid(),
  generation: z.number().int().positive(),
  state: z.enum(['connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  client_id: z.string().nullable(),
  subject: z.string().nullable(),
  email: z.string().nullable(),
  scopes: z.array(z.string()),
  credential: z.unknown(),
  expires_at: z.date().nullable(),
  welcome_acknowledged_at: z.date().nullable(),
  models: z.unknown(),
  models_fetched_at: z.date().nullable(),
});
type ConnectionRow = z.infer<typeof connectionRow>;
const attemptRow = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  mode: z.enum(chatGptConnectionModes),
  client_id: z.string(),
  redirect_uri: z.string(),
  secret: z.unknown(),
  status: z.enum(['pending', 'exchanging', 'completed', 'failed']),
  error_code: z.string().nullable(),
  expires_at: z.date(),
});
const storedModels = z.array(z.object({ slug: z.string(), label: z.string() })).max(200);
const credentialSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), idToken: z.string() });
type Credential = z.infer<typeof credentialSchema>;
const attemptSecretSchema = z.object({ verifier: z.string(), nonce: z.string() });
const envelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string().max(65536),
});
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
});
const oauthError = z.object({
  error: z.union([z.string(), z.object({ code: z.string().optional() }).loose()]).optional(),
  code: z.string().optional(),
});
const discoverySchema = z.object({
  issuer: z.string(),
  jwks_uri: z.url(),
  revocation_endpoint: z.url().optional(),
});
const modelsResponse = z.union([
  z.object({
    models: z.array(
      z.object({ slug: z.string(), display_name: z.string().optional(), visibility: z.string().optional() }).loose(),
    ),
  }),
  z.object({ data: z.array(z.object({ id: z.string() }).loose()) }),
]);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const keyPattern = z.string().regex(/^[a-f0-9]{64}$/i);

function tokenCipher(ring: IntegrationKeyring) {
  const aad = (binding: readonly (string | number)[]) => Buffer.from(JSON.stringify(['chatgpt-plan', ...binding]));
  return {
    encrypt(binding: readonly (string | number)[], value: unknown) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(keyPattern.parse(ring.keys[ring.activeKeyId]), 'hex'),
        nonce,
      );
      cipher.setAAD(aad(binding));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return {
        keyId: ring.activeKeyId,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    },
    decrypt<T>(binding: readonly (string | number)[], input: unknown, schema: z.ZodType<T>): T {
      try {
        const value = envelopeSchema.parse(input);
        const nonce = Buffer.from(value.nonce, 'base64');
        const tag = Buffer.from(value.tag, 'base64');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error('envelope');
        const cipher = createDecipheriv(
          'aes-256-gcm',
          Buffer.from(keyPattern.parse(ring.keys[value.keyId]), 'hex'),
          nonce,
        );
        cipher.setAAD(aad(binding));
        cipher.setAuthTag(tag);
        const plain = Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]);
        return schema.parse(JSON.parse(plain.toString('utf8')));
      } catch {
        throw new ChatGptPlanError('unavailable');
      }
    },
  };
}

function oauthErrorCode(body: unknown) {
  const parsed = oauthError.safeParse(body);
  if (!parsed.success) return null;
  const { error, code } = parsed.data;
  return (typeof error === 'string' ? error : error?.code) ?? code ?? null;
}

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The callback query of a Sign in with ChatGPT redirect, from the loopback listener or a URL the member pasted. */
export function parseChatGptCallback(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ChatGptPlanError('callback-invalid');
  }
  const redirectUri = `${url.protocol}//${url.host}${url.pathname}`;
  const state = url.searchParams.get('state');
  if (!redirectPattern.test(redirectUri) || !state || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(state))
    throw new ChatGptPlanError('callback-invalid');
  return {
    redirectUri,
    state,
    workspaceId: uuid.parse(state.slice(0, 36)),
    code: url.searchParams.get('code'),
    clientId: url.searchParams.get('client_id'),
    scope: url.searchParams.get('scope'),
    error: url.searchParams.get('error'),
  };
}

export function createChatGptPlan(options: {
  runtime: ChatGptPlanRuntime;
  keyring: IntegrationKeyring;
  /** The deployment's stable `urn:uuid:` host id. Only the API, which starts sign-ins, needs it. */
  hostId?: () => Promise<string>;
  fetcher?: typeof fetch;
}) {
  const cipher = tokenCipher(options.keyring);
  const fetcher = options.fetcher ?? fetch;
  let discovery: Promise<z.infer<typeof discoverySchema>> | null = null;
  let jwks: { uri: string; keys: JWTVerifyGetKey } | null = null;
  const credentialBinding = (workspaceId: string, row: Pick<ConnectionRow, 'owner_membership_id' | 'generation'>) =>
    ['credential', workspaceId, row.owner_membership_id, row.generation] as const;
  const attemptBinding = (workspaceId: string, attempt: { id: string; membership_id: string }) =>
    ['attempt', workspaceId, attempt.membership_id, attempt.id] as const;
  const table = (tx: AuthorizationTransaction, name: 'connections' | 'connection_attempts') =>
    qualified(tx.schema, `tf_subscription_${name}`);

  function openIdConfiguration() {
    discovery ??= (async () => {
      const response = await fetcher(discoveryEndpoint, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`OpenID configuration ${response.status}`);
      const parsed = discoverySchema.parse(await response.json());
      if (parsed.issuer !== chatGptIssuer) throw new Error('Unexpected OpenID issuer');
      return parsed;
    })().catch(error => {
      discovery = null;
      throw error;
    });
    return discovery;
  }

  async function verifyIdToken(idToken: string, clientId: string, nonce: string) {
    try {
      const configuration = await openIdConfiguration();
      if (jwks?.uri !== configuration.jwks_uri)
        jwks = { uri: configuration.jwks_uri, keys: createRemoteJWKSet(new URL(configuration.jwks_uri)) };
      const { payload } = await jwtVerify(idToken, jwks.keys, { issuer: chatGptIssuer, audience: clientId });
      if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub) throw new Error('claims');
      const email = typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : null;
      return { subject: payload.sub.slice(0, 512), email };
    } catch {
      throw new ChatGptPlanError('identity-invalid');
    }
  }

  async function tokenRequest(fields: Record<string, string>) {
    let response: Response;
    try {
      response = await fetcher(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { ok: false as const, status: 0, error: null };
    }
    const body = await readJson(response);
    if (!response.ok) return { ok: false as const, status: response.status, error: oauthErrorCode(body) };
    const parsed = tokenResponse.safeParse(body);
    if (!parsed.success) return { ok: false as const, status: response.status, error: null };
    return { ok: true as const, token: parsed.data };
  }

  async function fetchModels(accessToken: string): Promise<ChatGptModel[] | null> {
    try {
      const response = await fetcher(modelsEndpoint, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const parsed = modelsResponse.safeParse(await response.json());
      if (!parsed.success) return null;
      const models =
        'models' in parsed.data
          ? parsed.data.models
              .filter(model => model.visibility === 'list')
              .map(model => ({ slug: model.slug, label: model.display_name || model.slug }))
          : parsed.data.data.map(model => ({ slug: model.id, label: model.id }));
      return models.filter(model => model.slug.length <= 200 && model.label.length <= 200).slice(0, 200);
    } catch {
      return null;
    }
  }

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
    return connectionRow
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${table(tx, 'connections')} WHERE owner_membership_id=$1 AND provider='chatgpt' ${lock ? 'FOR UPDATE' : ''}`,
            [membershipId],
          )
        ).rows[0],
      );
  }

  function statusOf(row: ConnectionRow | undefined): ChatGptConnectionStatus {
    if (!row) return { state: 'not-connected', email: null, planUsage: false, welcomePending: false, models: [] };
    const planUsage = row.state === 'connected';
    return {
      state: row.state,
      email: row.email,
      planUsage,
      welcomePending: planUsage && row.welcome_acknowledged_at === null,
      models: planUsage ? (storedModels.safeParse(row.models).data ?? []) : [],
    };
  }

  async function fail(workspaceId: string, attemptId: string, code: ChatGptPlanErrorCode) {
    await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'connection_attempts')} SET status='failed',secret=NULL,error_code=$2 WHERE id=$1 AND status IN ('pending','exchanging')`,
        [attemptId, code],
      );
    });
    return new ChatGptPlanError(code);
  }

  /**
   * The member's access token, refreshed when it expires within five minutes. The connection row stays locked during
   * the refresh because refresh tokens rotate: a second concurrent refresh would reuse a spent token.
   */
  async function accessToken(workspaceId: string, membershipId: string) {
    const outcome = await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
      const row = await loadConnection(tx, membershipId, true);
      if (!row || row.state === 'signed-out') return { error: 'not-connected' as const };
      if (row.state === 'reconnect-required') return { error: 'reconnect-required' as const };
      if (row.state === 'plan-disabled') return { error: 'plan-disabled' as const };
      const credential = cipher.decrypt(credentialBinding(workspaceId, row), row.credential, credentialSchema);
      if (row.expires_at && row.expires_at.getTime() - Date.now() > refreshMarginMs)
        return { token: credential.accessToken, row };
      const refreshed = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: clientIdSchema.parse(row.client_id),
        refresh_token: credential.refreshToken,
        resource,
      });
      if (!refreshed.ok) {
        if (refreshed.error && terminalRefreshErrors.has(refreshed.error)) {
          await tx.client.query(
            `UPDATE ${table(tx, 'connections')} SET state='reconnect-required',credential=NULL,expires_at=NULL,scopes='{}',updated_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider='chatgpt'`,
            [membershipId],
          );
          return { error: 'reconnect-required' as const };
        }
        return { error: 'unavailable' as const };
      }
      const next: Credential = {
        accessToken: refreshed.token.access_token,
        refreshToken: refreshed.token.refresh_token ?? credential.refreshToken,
        idToken: refreshed.token.id_token ?? credential.idToken,
      };
      const scopes = refreshed.token.scope ? refreshed.token.scope.split(' ').filter(Boolean) : row.scopes;
      const planUsage = scopes.includes(planScope);
      await tx.client.query(
        `UPDATE ${table(tx, 'connections')} SET state=$2,credential=$3,scopes=$4,expires_at=clock_timestamp()+$5*interval '1 second',updated_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider='chatgpt'`,
        [
          membershipId,
          planUsage ? 'connected' : 'plan-disabled',
          cipher.encrypt(credentialBinding(workspaceId, row), next),
          scopes,
          refreshed.token.expires_in ?? 3600,
        ],
      );
      if (!planUsage) return { error: 'plan-disabled' as const };
      return { token: next.accessToken, row };
    });
    if ('error' in outcome) throw new ChatGptPlanError(outcome.error);
    return { accessToken: outcome.token, row: outcome.row };
  }

  async function refreshModels(workspaceId: string, membershipId: string) {
    const { accessToken: token } = await accessToken(workspaceId, membershipId);
    const models = await fetchModels(token);
    if (!models) return null;
    await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'connections')} SET models=$2,models_fetched_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider='chatgpt' AND state='connected'`,
        [membershipId, JSON.stringify(models)],
      );
    });
    return models;
  }

  const service = {
    async status(workspaceId: string, userId: string) {
      const { row, membershipId } = await authorized(workspaceId, userId, async (tx, actor) => ({
        row: await loadConnection(tx, actor.membershipId),
        membershipId: actor.membershipId,
      }));
      const status = statusOf(row);
      const stale =
        row?.state === 'connected' &&
        (!row.models_fetched_at || Date.now() - row.models_fetched_at.getTime() > modelsMaxAgeMs);
      if (!stale) return status;
      try {
        const models = await refreshModels(workspaceId, membershipId);
        return models ? { ...status, models } : status;
      } catch (error) {
        if (error instanceof ChatGptPlanError && error.code !== 'unavailable')
          return statusOf(await authorized(workspaceId, userId, (tx, actor) => loadConnection(tx, actor.membershipId)));
        return status;
      }
    },

    /** Starts a sign-in. The authorize URL carries no tokens, so it may reach the browser. */
    async begin(workspaceId: string, userId: string, mode: ChatGptConnectionMode, redirectUri: string) {
      workspaceId = uuid.parse(workspaceId);
      if (!redirectPattern.test(redirectUri)) throw new Error('ChatGPT redirect must be a 127.0.0.1 loopback callback');
      if (!options.hostId) throw new Error('ChatGPT sign-in needs the deployment host id');
      const hostId = await options.hostId();
      const state = `${workspaceId}.${randomBytes(32).toString('base64url')}`;
      const verifier = randomBytes(32).toString('base64url');
      const nonce = randomBytes(24).toString('base64url');
      const attemptId = randomUUID();
      const { clientId, loginHint } = await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          const recent = z
            .object({ count: z.number() })
            .parse(
              (
                await tx.client.query(
                  `SELECT count(*)::integer AS count FROM ${table(tx, 'connection_attempts')} WHERE membership_id=$1 AND provider='chatgpt' AND created_at>clock_timestamp()-interval '10 minutes'`,
                  [actor.membershipId],
                )
              ).rows[0],
            );
          if (recent.count >= 20) throw new ChatGptPlanError('rate-limited');
          const row = await loadConnection(tx, actor.membershipId);
          if (mode !== 'connect' && !row?.client_id) throw new ChatGptPlanError('not-connected');
          const clientId = row?.client_id ?? dynamicClient;
          await tx.client.query(
            `INSERT INTO ${table(tx, 'connection_attempts')} (id,provider,membership_id,state_hash,mode,client_id,redirect_uri,secret,status,expires_at)
             VALUES ($1,'chatgpt',$2,$3,$4,$5,$6,$7,'pending',clock_timestamp()+$8*interval '1 minute')`,
            [
              attemptId,
              actor.membershipId,
              sha256(state),
              mode,
              clientId,
              redirectUri,
              cipher.encrypt(attemptBinding(workspaceId, { id: attemptId, membership_id: actor.membershipId }), {
                verifier,
                nonce,
              }),
              attemptMinutes,
            ],
          );
          return { clientId, loginHint: mode === 'connect' ? null : row?.email };
        },
        'write',
      );
      const url = new URL(authorizeEndpoint);
      url.searchParams.set('client_id', clientId);
      if (clientId === dynamicClient) url.searchParams.set('agent_name_hint', 'TulipFarm');
      url.searchParams.set('ext_agent_host_id', hostId);
      // The URL reaches the browser, so reauthorization hints with the email only, never the retained ID token.
      if (loginHint) url.searchParams.set('login_hint', loginHint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', requestedScopes);
      url.searchParams.set('resource', resource);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      if (mode === 'enable-plan') url.searchParams.set('prompt', 'consent');
      return { attemptId, authorizeUrl: url.toString(), expiresInSeconds: attemptMinutes * 60 };
    },

    async attempt(workspaceId: string, userId: string, attemptId: string): Promise<ChatGptAttemptStatus> {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = attemptRow
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'connection_attempts')} WHERE id=$1 AND membership_id=$2 AND provider='chatgpt'`,
                [uuid.parse(attemptId), actor.membershipId],
              )
            ).rows[0],
          );
        if (!row) throw new ChatGptPlanError('attempt-not-found');
        if (row.status === 'completed') return { status: 'completed', errorCode: null };
        if (row.status === 'failed') return { status: 'failed', errorCode: row.error_code };
        if (row.expires_at.getTime() <= Date.now()) return { status: 'failed', errorCode: 'attempt-expired' };
        return { status: 'pending', errorCode: null };
      });
    },

    /**
     * Completes a sign-in from its redirect. The loopback listener passes no user: the unguessable state alone
     * identifies the attempt, as in any OAuth callback. A pasted URL must belong to the signed-in member's attempt.
     */
    async complete(callbackUrl: string, userId?: string) {
      const callback = parseChatGptCallback(callbackUrl);
      const { workspaceId } = callback;
      const claimed = await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
        let membershipId: string | null = null;
        if (userId) {
          await lockAuthorization(tx, 'write');
          const actor = await resolveHuman(tx, userId);
          await currentMember(tx, actor);
          membershipId = actor.membershipId;
        }
        const attempt = attemptRow
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'connection_attempts')} WHERE state_hash=$1 AND provider='chatgpt' FOR UPDATE`,
                [sha256(callback.state)],
              )
            ).rows[0],
          );
        if (!attempt || (membershipId && attempt.membership_id !== membershipId))
          return { error: 'attempt-not-found' as const };
        if (attempt.status === 'completed') return { done: true as const };
        if (attempt.status !== 'pending') return { error: 'attempt-not-found' as const };
        const close = async (code: ChatGptPlanErrorCode) => {
          await tx.client.query(
            `UPDATE ${table(tx, 'connection_attempts')} SET status='failed',secret=NULL,error_code=$2 WHERE id=$1`,
            [attempt.id, code],
          );
          return { error: code };
        };
        if (attempt.expires_at.getTime() <= Date.now()) return close('attempt-expired');
        if (callback.redirectUri !== attempt.redirect_uri) return close('callback-invalid');
        if (callback.error)
          return close(callback.error === 'access_denied' ? 'authorization-declined' : 'authorization-failed');
        if (!callback.code) return close('callback-invalid');
        let clientId = attempt.client_id;
        if (attempt.client_id === dynamicClient) {
          const issued = clientIdSchema.safeParse(callback.clientId);
          if (!issued.success || issued.data === dynamicClient) return close('registration-incomplete');
          clientId = issued.data;
        } else if (callback.clientId && callback.clientId !== attempt.client_id) return close('client-mismatch');
        const secret = cipher.decrypt(attemptBinding(workspaceId, attempt), attempt.secret, attemptSecretSchema);
        // The issued client id is saved before the exchange so a retry after a failed exchange reuses it.
        await tx.client.query(
          `INSERT INTO ${table(tx, 'connections')} (id,provider,owner_membership_id,state,client_id) VALUES ($3,'chatgpt',$1,'signed-out',$2)
           ON CONFLICT (owner_membership_id,provider) DO UPDATE SET client_id=EXCLUDED.client_id,updated_at=clock_timestamp()
           WHERE ${table(tx, 'connections')}.client_id IS NULL OR ${table(tx, 'connections')}.client_id=EXCLUDED.client_id OR ${table(tx, 'connections')}.state IN ('signed-out','reconnect-required')`,
          [attempt.membership_id, clientId, randomUUID()],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'connection_attempts')} SET status='exchanging',secret=NULL,client_id=$2 WHERE id=$1`,
          [attempt.id, clientId],
        );
        return { attempt, clientId, secret, code: callback.code };
      });
      if ('done' in claimed) return { workspaceId };
      if ('error' in claimed) throw new ChatGptPlanError(claimed.error);
      const { attempt, clientId, secret, code } = claimed;
      const exchanged = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: secret.verifier,
        redirect_uri: attempt.redirect_uri,
        resource,
      });
      if (!exchanged.ok)
        throw await fail(
          workspaceId,
          attempt.id,
          exchanged.error === 'invalid_grant' ? 'code-rejected' : 'exchange-failed',
        );
      const { token } = exchanged;
      if (!token.refresh_token || !token.id_token) throw await fail(workspaceId, attempt.id, 'exchange-failed');
      let identity: { subject: string; email: string | null };
      try {
        identity = await verifyIdToken(token.id_token, clientId, secret.nonce);
      } catch {
        throw await fail(workspaceId, attempt.id, 'identity-invalid');
      }
      const scopes = (token.scope ?? callback.scope ?? '').split(' ').filter(Boolean);
      const planUsage = scopes.includes(planScope);
      const credential: Credential = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        idToken: token.id_token,
      };
      const saved = await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
        const row = await loadConnection(tx, attempt.membership_id, true);
        if (!row) return 'attempt-not-found' as const;
        // Reauthorization must return the same ChatGPT account; a fresh connect may switch accounts.
        if (attempt.mode !== 'connect' && row.subject !== null && row.subject !== identity.subject)
          return 'account-mismatch' as const;
        if (row.client_id !== clientId) return 'client-mismatch' as const;
        const generation = row.generation + 1;
        await tx.client.query(
          `UPDATE ${table(tx, 'connections')} SET generation=$2,state=$3,subject=$4,email=$5,scopes=$6,credential=$7,
             expires_at=clock_timestamp()+$8*interval '1 second',models=NULL,models_fetched_at=NULL,
             welcome_acknowledged_at=CASE WHEN subject IS DISTINCT FROM $4 THEN NULL ELSE welcome_acknowledged_at END,
             updated_at=clock_timestamp()
           WHERE owner_membership_id=$1 AND provider='chatgpt'`,
          [
            attempt.membership_id,
            generation,
            planUsage ? 'connected' : 'plan-disabled',
            identity.subject,
            identity.email,
            scopes,
            cipher.encrypt(
              credentialBinding(workspaceId, { owner_membership_id: row.owner_membership_id, generation }),
              credential,
            ),
            token.expires_in ?? 3600,
          ],
        );
        await tx.client.query(`UPDATE ${table(tx, 'connection_attempts')} SET status='completed' WHERE id=$1`, [
          attempt.id,
        ]);
        return null;
      });
      if (saved) throw await fail(workspaceId, attempt.id, saved);
      if (planUsage) await refreshModels(workspaceId, attempt.membership_id).catch(() => null);
      return { workspaceId };
    },

    async acknowledgeWelcome(workspaceId: string, userId: string) {
      await authorized(
        workspaceId,
        userId,
        async (tx, actor) => {
          await tx.client.query(
            `UPDATE ${table(tx, 'connections')} SET welcome_acknowledged_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider='chatgpt' AND welcome_acknowledged_at IS NULL`,
            [actor.membershipId],
          );
        },
        'write',
      );
    },

    /** Revokes the refresh token, then clears the tokens. The client id and account stay for the next sign-in. */
    async disconnect(workspaceId: string, userId: string) {
      const found = await authorized(workspaceId, userId, async (tx, actor) => {
        const row = await loadConnection(tx, actor.membershipId);
        if (!row) return null;
        const credential =
          row.credential === null
            ? null
            : cipher.decrypt(credentialBinding(workspaceId, row), row.credential, credentialSchema);
        return { membershipId: actor.membershipId, clientId: row.client_id, credential };
      });
      if (!found) return { revoked: true };
      let revoked = found.credential === null;
      if (found.credential && found.clientId) {
        const endpoint = await openIdConfiguration()
          .then(configuration => configuration.revocation_endpoint ?? null)
          .catch(() => null);
        for (let attempt = 0; endpoint && attempt < 3 && !revoked; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
          try {
            const response = await fetcher(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: found.credential.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: found.clientId,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) revoked = true;
            else if (response.status < 500) break;
          } catch {
            // A network failure is retried; the tokens are cleared locally either way.
          }
        }
      }
      await authorized(
        workspaceId,
        userId,
        async tx => {
          await tx.client.query(
            `UPDATE ${table(tx, 'connections')} SET state='signed-out',credential=NULL,expires_at=NULL,scopes='{}',models=NULL,models_fetched_at=NULL,updated_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider='chatgpt'`,
            [found.membershipId],
          );
          // Signing out ends every share: a later sign-in starts private again.
          await tx.client.query(
            `DELETE FROM ${qualified(tx.schema, 'tf_subscription_grants')} WHERE connection_id IN (SELECT id FROM ${table(tx, 'connections')} WHERE owner_membership_id=$1 AND provider='chatgpt')`,
            [found.membershipId],
          );
        },
        'write',
      );
      return { revoked };
    },

    /** The live ChatGPT model slugs a member may pick, or an empty list when they can't use their plan. */
    async memberModels(workspaceId: string, userId: string) {
      try {
        const status = await service.status(workspaceId, userId);
        return status.planUsage ? status.models.map(model => model.slug) : [];
      } catch (error) {
        if (error instanceof AccessDenied || error instanceof ChatGptPlanError) return [];
        throw error;
      }
    },

    /** For a reply worker: the requesting member's current access token, refreshed when needed. */
    async accessToken(workspaceId: string, membershipId: string) {
      return (await accessToken(workspaceId, uuid.parse(membershipId))).accessToken;
    },

    /** Marks a connection whose token OpenAI rejected so the member is asked to reconnect. */
    async requireReconnect(workspaceId: string, membershipId: string) {
      await options.runtime.transaction(uuid.parse(workspaceId), commonCompatibility, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'connections')} SET state='reconnect-required',credential=NULL,expires_at=NULL,scopes='{}',updated_at=clock_timestamp() WHERE owner_membership_id=$1 AND provider='chatgpt' AND state='connected'`,
          [uuid.parse(membershipId)],
        );
      });
    },
  };
  return service;
}
export type ChatGptPlan = ReturnType<typeof createChatGptPlan>;
