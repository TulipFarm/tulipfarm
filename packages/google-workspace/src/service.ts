import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type HumanActor,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { IntegrationKeyring } from '@tulipfarm/integrations/credentials';
import {
  callbackSchema,
  GoogleCallbackError,
  GoogleWorkspaceError,
  googleAppScopes,
  googleIdentityScopes,
  googleWorkspaceConfig,
  googleWorkspaceScopes,
  sessionPrincipalSchema,
  type GoogleApp,
  type GoogleStatus,
  type GoogleWorkspaceConfig,
  type SessionPrincipal,
} from './contracts.ts';
import { googleCredentialCipher, tokenBundleSchema, type CredentialBinding, type TokenBundle } from './credentials.ts';
import { googleProvider } from './provider.ts';
import { GoogleFileError } from './file-contracts.ts';
import { GoogleOperationError } from './operation-contracts.ts';
import { watchIntegrationRecommendations, type DefaultKnowledgeHook } from '@tulipfarm/integrations/authorization';
import { googleRecommendations } from './recommendations.ts';

export { googleWorkspaceConfig } from './contracts.ts';
export type GoogleExecutionFence = {
  workspaceId: string;
  actor: HumanActor | string;
  integrationId: string;
  accountId: string;
  generation: number;
  requiredScopes: readonly string[];
};
const compatibility = commonCompatibility;
const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const rowSchema = z.object({
  id: z.uuid(),
  user_id: z.string(),
  membership_id: z.uuid(),
  generation: z.number().int().positive(),
  status: z.enum(['disconnected', 'connected', 'reconnect-required']),
  account_id: z.string().nullable(),
  email: z.string().nullable(),
  scopes: z.array(z.string()),
  credential: z.unknown(),
});
type Row = z.infer<typeof rowSchema>;
function binding(workspaceId: string, row: Row): CredentialBinding {
  return {
    workspaceId: uuidSchema.parse(workspaceId),
    integrationId: row.id,
    userId: row.user_id,
    membershipId: row.membership_id,
    accountId: row.account_id,
    generation: row.generation,
  };
}
function metadata(row: Row | undefined): GoogleStatus {
  if (!row || row.status === 'disconnected' || !row.account_id || !row.email) return { status: 'disconnected' };
  return {
    status: row.status,
    integrationId: row.id,
    generation: row.generation,
    accountId: row.account_id,
    email: row.email,
    scopes: row.scopes,
  };
}
const googleKnowledgeScopes = {
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://mail.google.com/',
  ],
} as const;
function scopes(value: string) {
  return [
    ...new Set(
      value
        .split(/\s+/)
        .filter(Boolean)
        .map(scope => (scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope)),
    ),
  ].sort();
}

export function createGoogleWorkspaceService(options: {
  runtime: Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
  keyring?: IntegrationKeyring;
  config?: GoogleWorkspaceConfig;
  providerFetch?: typeof fetch;
  now?: () => number;
  defaultKnowledge?: DefaultKnowledgeHook;
}) {
  const cipher = googleCredentialCipher(options.keyring);
  const config = options.config ?? googleWorkspaceConfig();
  const now = options.now ?? Date.now;
  function provider() {
    if (!config) throw new GoogleWorkspaceError('not-configured');
    return googleProvider(config, options.providerFetch);
  }
  async function authorized<T>(
    workspaceId: string,
    principal: string | HumanActor,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return options.runtime.transaction(uuidSchema.parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx);
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  async function load(tx: AuthorizationTransaction, actor: HumanActor) {
    return rowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'tf_google_integrations')} WHERE membership_id = $1 AND user_id = $2 FOR UPDATE`,
            [actor.membershipId, actor.userId],
          )
        ).rows[0],
      );
  }
  async function storeTokens(
    tx: AuthorizationTransaction,
    workspaceId: string,
    row: Row,
    tokens: TokenBundle,
    grantedScopes: string[],
  ) {
    const recommendations = await watchIntegrationRecommendations(tx, row.id, () => googleRecommendations(tx, row.id));
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_google_integrations')} SET status = 'connected', account_id = $2, email = $3, scopes = $4, credential = $5, generation = $6 WHERE id = $1`,
      [
        row.id,
        row.account_id,
        row.email,
        grantedScopes,
        cipher.encrypt('tokens', binding(workspaceId, row), JSON.stringify(tokens)),
        row.generation,
      ],
    );
    await recommendations();
  }
  async function invalidate(tx: AuthorizationTransaction, row: Row) {
    const recommendations = await watchIntegrationRecommendations(tx, row.id, () => googleRecommendations(tx, row.id));
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_google_integrations')} SET status = 'reconnect-required', credential = NULL, generation = generation + 1 WHERE id = $1`,
      [row.id],
    );
    await tx.client.query(`DELETE FROM ${relation(tx, 'tf_google_oauth_states')} WHERE integration_id = $1`, [row.id]);
    await recommendations();
  }
  const service = {
    availability() {
      return { configured: config !== undefined };
    },
    async status(workspaceId: string, userId: string): Promise<GoogleStatus> {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, actor);
        if (row?.status === 'connected') {
          const tokens = tokenBundleSchema.parse(
            JSON.parse(cipher.decrypt('tokens', binding(workspaceId, row), row.credential)),
          );
          if (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= now()) {
            await invalidate(tx, row);
            return metadata({ ...row, status: 'reconnect-required', generation: row.generation + 1 });
          }
        }
        return metadata(row);
      });
    },
    async begin(workspaceId: string, principal: SessionPrincipal, app?: GoogleApp) {
      workspaceId = uuidSchema.parse(workspaceId);
      principal = sessionPrincipalSchema.parse(principal);
      provider();
      if (!config) throw new GoogleWorkspaceError('not-configured');
      return authorized(workspaceId, principal.userId, async (tx, actor) => {
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_google_integrations')} (id, user_id, membership_id, generation, status) VALUES ($1,$2,$3,1,'disconnected') ON CONFLICT (membership_id) DO NOTHING`,
          [randomUUID(), actor.userId, actor.membershipId],
        );
        const row = await load(tx, actor);
        if (!row) throw new AccessDenied();
        // A connected row keeps its generation so adding an app does not cancel pending approvals.
        if (row.status !== 'connected') {
          row.generation++;
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_google_integrations')} SET generation = $2, credential = NULL WHERE id = $1`,
            [row.id, row.generation],
          );
        }
        const state = `${workspaceId}.${randomBytes(32).toString('base64url')}`;
        const verifier = randomBytes(32).toString('base64url');
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_google_oauth_states')} (integration_id, state_hash, session_hash, generation, verifier, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (integration_id) DO UPDATE SET state_hash = EXCLUDED.state_hash, session_hash = EXCLUDED.session_hash, generation = EXCLUDED.generation, verifier = EXCLUDED.verifier, expires_at = EXCLUDED.expires_at`,
          [
            row.id,
            digest(state),
            digest(principal.sessionId),
            row.generation,
            cipher.encrypt('pkce', binding(workspaceId, row), verifier),
            new Date(now() + 600_000),
          ],
        );
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          response_type: 'code',
          scope: (app ? [...googleIdentityScopes, ...googleAppScopes[app]] : googleWorkspaceScopes).join(' '),
          include_granted_scopes: 'true',
          access_type: 'offline',
          prompt: 'consent select_account',
          state,
          code_challenge: digest(verifier),
          code_challenge_method: 'S256',
        }).toString();
        return { authorizationUrl: url.href };
      });
    },
    async complete(principal: SessionPrincipal, input: z.input<typeof callbackSchema>): Promise<GoogleStatus> {
      principal = sessionPrincipalSchema.parse(principal);
      const callback = callbackSchema.parse(input);
      const workspace = uuidSchema.safeParse(callback.state.split('.')[0]);
      if (!workspace.success) throw new GoogleWorkspaceError('invalid-state');
      const workspaceId = workspace.data;
      const prepared = await authorized(workspaceId, principal.userId, async (tx, actor) => {
        const row = await load(tx, actor);
        if (!row) throw new GoogleWorkspaceError('invalid-state');
        const attempt = z
          .object({ verifier: z.unknown() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `DELETE FROM ${relation(tx, 'tf_google_oauth_states')} WHERE integration_id = $1 AND state_hash = $2 AND session_hash = $3 AND generation = $4 AND expires_at > $5 RETURNING verifier`,
                [row.id, digest(callback.state), digest(principal.sessionId), row.generation, new Date(now())],
              )
            ).rows[0],
          );
        if (!attempt) throw new GoogleWorkspaceError('invalid-state');
        return { row, actor, verifier: attempt.verifier };
      });
      try {
        if (callback.error || !callback.code) throw new GoogleWorkspaceError('consent-denied');
        const oauth = provider();
        const result = await oauth.exchange(
          callback.code,
          cipher.decrypt('pkce', binding(workspaceId, prepared.row), prepared.verifier),
        );
        if (!result.refresh_token) throw new GoogleWorkspaceError('reconnect-required');
        const refreshToken = result.refresh_token;
        const grantedScopes = scopes(result.scope ?? '');
        if (!googleIdentityScopes.every(scope => grantedScopes.includes(scope)))
          throw new GoogleWorkspaceError('insufficient-scope');
        const account = await oauth.account(result.access_token);
        const automatic =
          options.defaultKnowledge && (await options.defaultKnowledge.enabled(workspaceId, principal.userId))
            ? options.defaultKnowledge
            : undefined;
        const intents: string[] = [];
        const status = await authorized(workspaceId, prepared.actor, async (tx, actor) => {
          const row = await load(tx, actor);
          if (!row || row.id !== prepared.row.id || row.generation !== prepared.row.generation)
            throw new GoogleWorkspaceError('stale-integration');
          const accountReplaced = row.account_id !== null && row.account_id !== account.sub;
          const consented = {
            ...row,
            account_id: account.sub,
            email: account.email,
            generation: accountReplaced ? row.generation + 1 : row.generation,
          };
          const tokens = {
            accessToken: result.access_token,
            refreshToken,
            expiresAt: now() + result.expires_in * 1000,
            refreshExpiresAt: result.refresh_token_expires_in ? now() + result.refresh_token_expires_in * 1000 : null,
          };
          await storeTokens(tx, workspaceId, consented, tokens, grantedScopes);
          if (automatic) {
            // Only a newly granted Drive or Gmail read scope is a new enablement; reauthorization keeps prior scopes.
            const previous = accountReplaced ? [] : row.scopes;
            for (const [product, accepted] of [
              ['google-drive', googleKnowledgeScopes.drive],
              ['gmail', googleKnowledgeScopes.gmail],
            ] as const) {
              if (
                !accepted.some(scope => grantedScopes.includes(scope)) ||
                accepted.some(scope => previous.includes(scope))
              )
                continue;
              const recorded = await automatic.record(tx, {
                product,
                membershipId: actor.membershipId,
                accountKey: account.sub,
                accountLabel: account.email,
              });
              if (recorded.created) intents.push(recorded.intentId);
            }
          }
          return metadata({ ...consented, status: 'connected', scopes: grantedScopes });
        });
        if (automatic && intents.length) automatic.started?.(workspaceId, intents);
        return status;
      } catch (error) {
        throw new GoogleCallbackError(
          error instanceof GoogleWorkspaceError
            ? error.code
            : error instanceof AccessDenied
              ? 'integration-not-found'
              : 'integration-operation-failed',
          workspaceId,
        );
      }
    },
    async disconnect(workspaceId: string, userId: string) {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, actor);
        if (!row) return { disconnected: true as const, revoked: true };
        const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
          googleRecommendations(tx, row.id),
        );
        let revoked = true;
        if (row.status === 'connected') {
          try {
            const tokens = tokenBundleSchema.parse(
              JSON.parse(cipher.decrypt('tokens', binding(workspaceId, row), row.credential)),
            );
            revoked = await provider().revoke(tokens.refreshToken);
          } catch {
            revoked = false;
          }
        }
        await tx.client.query(`DELETE FROM ${relation(tx, 'tf_google_oauth_states')} WHERE integration_id = $1`, [
          row.id,
        ]);
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_google_integrations')} SET generation = generation + 1, status = 'disconnected', account_id = NULL, email = NULL, scopes = '{}', credential = NULL WHERE id = $1`,
          [row.id],
        );
        await recommendations();
        return { disconnected: true as const, revoked };
      });
    },
    async withCredential<T>(
      fence: GoogleExecutionFence,
      operation: (credential: { accessToken: string; signal: AbortSignal }, tx: AuthorizationTransaction) => Promise<T>,
    ): Promise<T> {
      const outcome = await authorized(fence.workspaceId, fence.actor, async (tx, actor) => {
        const row = await load(tx, actor);
        if (
          !row ||
          row.id !== fence.integrationId ||
          row.account_id !== fence.accountId ||
          row.generation !== fence.generation
        )
          throw new GoogleWorkspaceError('stale-integration');
        if (row.status !== 'connected') throw new GoogleWorkspaceError('reconnect-required');
        if (!fence.requiredScopes.every(scope => row.scopes.includes(scope)))
          throw new GoogleWorkspaceError('insufficient-scope');
        let tokens = tokenBundleSchema.parse(
          JSON.parse(cipher.decrypt('tokens', binding(fence.workspaceId, row), row.credential)),
        );
        if (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= now()) {
          await invalidate(tx, row);
          return { kind: 'error' as const, error: new GoogleWorkspaceError('reconnect-required') };
        }
        if (tokens.expiresAt <= now() + 60_000) {
          try {
            const refreshed = await provider().refresh(tokens.refreshToken);
            const granted = refreshed.scope === undefined ? row.scopes : scopes(refreshed.scope);
            tokens = {
              accessToken: refreshed.access_token,
              refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
              expiresAt: now() + refreshed.expires_in * 1000,
              refreshExpiresAt: refreshed.refresh_token_expires_in
                ? now() + refreshed.refresh_token_expires_in * 1000
                : tokens.refreshExpiresAt,
            };
            await storeTokens(tx, fence.workspaceId, row, tokens, granted);
            if (!fence.requiredScopes.every(scope => granted.includes(scope)))
              return { kind: 'error' as const, error: new GoogleWorkspaceError('insufficient-scope') };
          } catch (error) {
            if (!(error instanceof GoogleWorkspaceError) || error.code !== 'reconnect-required') throw error;
            await invalidate(tx, row);
            return { kind: 'error' as const, error: new GoogleWorkspaceError('reconnect-required') };
          }
        }
        try {
          return {
            kind: 'success' as const,
            value: await operation({ accessToken: tokens.accessToken, signal: AbortSignal.timeout(4000) }, tx),
          };
        } catch (error) {
          return { kind: 'error' as const, error };
        }
      });
      if (outcome.kind === 'error') throw outcome.error;
      return outcome.value;
    },
    async withReadCredential<T>(
      fence: GoogleExecutionFence,
      operation: (credential: { accessToken: string; signal: AbortSignal }) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const deadline = AbortSignal.timeout(15_000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const checkAbort = () => {
        if (combined.aborted)
          throw combined.reason?.name === 'TimeoutError'
            ? new GoogleFileError('transfer-timeout')
            : new GoogleOperationError('cancelled');
      };
      checkAbort();
      const accessToken = await service.withCredential(fence, async credential => credential.accessToken);
      checkAbort();
      const result = await operation({ accessToken, signal: combined });
      checkAbort();
      await service.withCredential(fence, async () => {
        checkAbort();
      });
      checkAbort();
      return result;
    },
  };
  return service;
}
