import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  type AuthorizationTransaction,
  currentMember,
  type HumanActor,
  lockAndResolvePrincipal,
} from '@tulipfarm/access';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { IntegrationKeyring } from '@tulipfarm/integrations/credentials';
import {
  callbackSchema,
  GoogleCallbackError,
  GoogleWorkspaceError,
  googleAppScopes,
  googleBeginOptionsSchema,
  googleGrantsUpdateSchema,
  googleIdentityScopes,
  googleOwnershipSchema,
  googleWorkspaceConfig,
  googleWorkspaceScopes,
  sessionPrincipalSchema,
  type GoogleAccountSummary,
  type GoogleApp,
  type GoogleBeginOptions,
  type GoogleGrantsResponse,
  type GoogleGrantsUpdate,
  type GoogleGrantTarget,
  type GoogleStatus,
  type GoogleWorkspaceConfig,
  type SessionPrincipal,
} from './contracts.ts';
import { googleCallbackOutcomeSchema } from './callback-contracts.ts';
import { googleCredentialCipher, tokenBundleSchema, type CredentialBinding, type TokenBundle } from './credentials.ts';
import { googleAccountAccess, granteeKey } from './grants.ts';
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
const maxAccountsPerBucket = 20;
const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const rowSchema = z.object({
  id: z.uuid(),
  user_id: z.string(),
  membership_id: z.uuid(),
  ownership: googleOwnershipSchema,
  grants_version: z.number().int().positive(),
  label: z.string().nullable(),
  generation: z.number().int().positive(),
  status: z.enum(['disconnected', 'connected', 'reconnect-required']),
  account_id: z.string().nullable(),
  email: z.string().nullable(),
  scopes: z.array(z.string()),
  credential: z.unknown(),
});
type Row = z.infer<typeof rowSchema>;
const grantRowSchema = z.object({
  grantee: z.string(),
  membership_id: z.uuid().nullable(),
  team_id: z.uuid().nullable(),
  role: z.enum(['use', 'manage']),
});
function toGrantTarget(row: z.infer<typeof grantRowSchema>): GoogleGrantTarget {
  if (row.grantee === 'workspace') return { kind: 'workspace', role: row.role };
  if (row.membership_id) return { kind: 'member', membershipId: row.membership_id, role: row.role };
  if (row.team_id) return { kind: 'team', teamId: row.team_id, role: row.role };
  throw new GoogleWorkspaceError('invalid-grant');
}
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
function summary(row: Row, access: { canUse: boolean; canManage: boolean }): GoogleAccountSummary {
  return {
    integrationId: row.id,
    ownership: row.ownership,
    status: row.status,
    ...(row.account_id !== null ? { accountId: row.account_id } : {}),
    ...(row.email !== null ? { email: row.email } : {}),
    ...(row.label !== null ? { label: row.label } : {}),
    generation: row.generation,
    grantsVersion: row.grants_version,
    scopes: row.scopes,
    canUse: access.canUse,
    canManage: access.canManage,
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
      const actor = await lockAndResolvePrincipal(tx, principal);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  async function loadPersonal(tx: AuthorizationTransaction, actor: HumanActor) {
    return rowSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT * FROM ${relation(tx, 'tf_google_integrations')}
             WHERE membership_id = $1 AND user_id = $2 AND ownership = 'personal'
             ORDER BY (status = 'connected') DESC, (status = 'reconnect-required') DESC, id ASC
             LIMIT 1 FOR UPDATE`,
          [actor.membershipId, actor.userId],
        )
      ).rows[0],
    );
  }
  async function loadById(tx: AuthorizationTransaction, integrationId: string) {
    return rowSchema
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_google_integrations')} WHERE id = $1 FOR UPDATE`, [
            integrationId,
          ])
        ).rows[0],
      );
  }
  async function checkRefreshExpiry(tx: AuthorizationTransaction, workspaceId: string, row: Row): Promise<Row> {
    if (row.status !== 'connected') return row;
    const tokens = tokenBundleSchema.parse(
      JSON.parse(cipher.decrypt('tokens', binding(workspaceId, row), row.credential)),
    );
    if (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= now()) {
      await invalidate(tx, row);
      return { ...row, status: 'reconnect-required', credential: null, generation: row.generation + 1 };
    }
    return row;
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
        const row = await loadPersonal(tx, actor);
        return metadata(row ? await checkRefreshExpiry(tx, workspaceId, row) : undefined);
      });
    },
    async list(workspaceId: string, userId: string): Promise<GoogleAccountSummary[]> {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const rows = z.array(rowSchema).parse(
          (
            await tx.client.query(
              `SELECT i.* FROM ${relation(tx, 'tf_google_integrations')} i
                 WHERE i.status <> 'disconnected'
                   AND (
                     (i.ownership = 'personal' AND i.membership_id = $1 AND i.user_id = $2)
                     OR (i.ownership = 'shared' AND EXISTS (
                       SELECT 1 FROM ${relation(tx, 'tf_google_grants')} g
                       WHERE g.integration_id = i.id
                         AND (
                           g.grantee = 'workspace'
                           OR g.membership_id = $1
                           OR EXISTS (
                             SELECT 1 FROM ${relation(tx, 'tf_member_teams')} mt
                             WHERE mt.team_id = g.team_id AND mt.membership_id = $1
                           )
                         )
                     ))
                   )
                 ORDER BY (i.ownership = 'personal') DESC, lower(i.email) ASC NULLS LAST, i.id ASC
                 FOR UPDATE OF i`,
              [actor.membershipId, actor.userId],
            )
          ).rows,
        );
        const accounts: GoogleAccountSummary[] = [];
        for (const row of rows) {
          const current = await checkRefreshExpiry(tx, workspaceId, row);
          const access = await googleAccountAccess(tx, actor, current);
          if (access.canUse) accounts.push(summary(current, access));
        }
        return accounts;
      });
    },
    async begin(workspaceId: string, principal: SessionPrincipal, app?: GoogleApp, options?: GoogleBeginOptions) {
      workspaceId = uuidSchema.parse(workspaceId);
      principal = sessionPrincipalSchema.parse(principal);
      const parsedOptions = googleBeginOptionsSchema.optional().parse(options);
      provider();
      if (!config) throw new GoogleWorkspaceError('not-configured');
      return authorized(workspaceId, principal.userId, async (tx, actor) => {
        let row: Row | undefined;
        if (parsedOptions?.integrationId) {
          row = await loadById(tx, parsedOptions.integrationId);
          if (!row || !(await googleAccountAccess(tx, actor, row)).canManage) throw new AccessDenied();
          if (parsedOptions.label !== undefined) {
            await tx.client.query(`UPDATE ${relation(tx, 'tf_google_integrations')} SET label = $2 WHERE id = $1`, [
              row.id,
              parsedOptions.label,
            ]);
            row = { ...row, label: parsedOptions.label };
          }
          // A connected row keeps its generation so adding an app does not cancel pending approvals.
          if (row.status !== 'connected') {
            row = { ...row, generation: row.generation + 1, credential: null };
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_google_integrations')} SET generation = $2, credential = NULL WHERE id = $1`,
              [row.id, row.generation],
            );
          }
        } else if (parsedOptions?.newAccount || parsedOptions?.ownership === 'shared') {
          const ownership = parsedOptions.ownership ?? 'personal';
          const count = z.number().parse(
            (ownership === 'personal'
              ? await tx.client.query(
                  `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_google_integrations')}
                       WHERE membership_id = $1 AND ownership = 'personal' AND status <> 'disconnected'`,
                  [actor.membershipId],
                )
              : await tx.client.query(
                  `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_google_integrations')}
                       WHERE ownership = 'shared' AND status <> 'disconnected'`,
                )
            ).rows[0]?.count,
          );
          if (count >= maxAccountsPerBucket) throw new GoogleWorkspaceError('account-limit');
          const id = randomUUID();
          row = rowSchema.parse(
            (
              await tx.client.query(
                `INSERT INTO ${relation(tx, 'tf_google_integrations')} (id, user_id, membership_id, ownership, label, generation, status)
                 VALUES ($1, $2, $3, $4, $5, 1, 'disconnected') RETURNING *`,
                [id, actor.userId, actor.membershipId, ownership, parsedOptions.label ?? null],
              )
            ).rows[0],
          );
          if (ownership === 'shared') {
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_google_grants')} (integration_id, grantee, membership_id, team_id, role, granted_by)
               VALUES ($1, $2, $3, NULL, 'manage', $3)`,
              [row.id, `member:${actor.membershipId}`, actor.membershipId],
            );
          }
        } else {
          row = await loadPersonal(tx, actor);
          if (!row) {
            row = rowSchema.parse(
              (
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_google_integrations')} (id, user_id, membership_id, ownership, label, generation, status)
                   VALUES ($1, $2, $3, 'personal', $4, 1, 'disconnected') RETURNING *`,
                  [randomUUID(), actor.userId, actor.membershipId, parsedOptions?.label ?? null],
                )
              ).rows[0],
            );
          } else if (parsedOptions?.label !== undefined) {
            await tx.client.query(`UPDATE ${relation(tx, 'tf_google_integrations')} SET label = $2 WHERE id = $1`, [
              row.id,
              parsedOptions.label,
            ]);
            row = { ...row, label: parsedOptions.label };
          }
          // A connected row keeps its generation so adding an app does not cancel pending approvals.
          if (row.status !== 'connected') {
            row = { ...row, generation: row.generation + 1, credential: null };
            await tx.client.query(
              `UPDATE ${relation(tx, 'tf_google_integrations')} SET generation = $2, credential = NULL WHERE id = $1`,
              [row.id, row.generation],
            );
          }
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
        const pending = z
          .object({ integration_id: z.uuid() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT integration_id FROM ${relation(tx, 'tf_google_oauth_states')}
                 WHERE state_hash = $1 AND session_hash = $2 AND expires_at > $3`,
                [digest(callback.state), digest(principal.sessionId), new Date(now())],
              )
            ).rows[0],
          );
        if (!pending) throw new GoogleWorkspaceError('invalid-state');
        const row = await loadById(tx, pending.integration_id);
        if (!row || !(await googleAccountAccess(tx, actor, row)).canManage)
          throw new GoogleWorkspaceError('invalid-state');
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
        const automatic = options.defaultKnowledge;
        const intents: string[] = [];
        const status = await authorized(workspaceId, prepared.actor, async (tx, actor) => {
          const row = await loadById(tx, prepared.row.id);
          if (
            !row ||
            !(await googleAccountAccess(tx, actor, row)).canManage ||
            row.generation !== prepared.row.generation
          )
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
          if (automatic && row.ownership === 'personal') {
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
        const mapped =
          error instanceof GoogleWorkspaceError
            ? googleCallbackOutcomeSchema.safeParse(error.code)
            : { success: false as const };
        const outcome: GoogleCallbackError['outcome'] =
          mapped.success && mapped.data !== 'connected'
            ? mapped.data
            : error instanceof AccessDenied
              ? 'integration-not-found'
              : 'integration-operation-failed';
        throw new GoogleCallbackError(outcome, workspaceId);
      }
    },
    async disconnect(workspaceId: string, userId: string, integrationId?: string) {
      const targetId = integrationId !== undefined ? uuidSchema.parse(integrationId) : undefined;
      return authorized(workspaceId, userId, async (tx, actor) => {
        let row: Row | undefined;
        if (targetId !== undefined) {
          row = await loadById(tx, targetId);
          if (!row || !(await googleAccountAccess(tx, actor, row)).canManage) throw new AccessDenied();
        } else {
          row = await loadPersonal(tx, actor);
          if (!row) return { disconnected: true as const, revoked: true };
        }
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
    async listGrants(workspaceId: string, userId: string, integrationId: string): Promise<GoogleGrantsResponse> {
      const id = uuidSchema.parse(integrationId);
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await loadById(tx, id);
        if (!row || row.status === 'disconnected' || !(await googleAccountAccess(tx, actor, row)).canManage)
          throw new AccessDenied();
        const rows = z.array(grantRowSchema).parse(
          (
            await tx.client.query(
              `SELECT grantee, membership_id, team_id, role
                 FROM ${relation(tx, 'tf_google_grants')}
                 WHERE integration_id = $1
                 ORDER BY grantee ASC`,
              [row.id],
            )
          ).rows,
        );
        return {
          integrationId: row.id,
          grantsVersion: row.grants_version,
          grants: rows.map(toGrantTarget),
        };
      });
    },
    async setGrants(
      workspaceId: string,
      userId: string,
      integrationId: string,
      input: GoogleGrantsUpdate,
    ): Promise<GoogleGrantsResponse> {
      const id = uuidSchema.parse(integrationId);
      const parsed = googleGrantsUpdateSchema.parse(input);
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await loadById(tx, id);
        if (!row || row.status === 'disconnected' || !(await googleAccountAccess(tx, actor, row)).canManage)
          throw new AccessDenied();
        if (row.grants_version !== parsed.expectedGrantsVersion) throw new GoogleWorkspaceError('grants-conflict');
        if (parsed.grants.length === 0) {
          await tx.client.query(`DELETE FROM ${relation(tx, 'tf_google_grants')} WHERE integration_id = $1`, [row.id]);
          const nextVersion = z
            .number()
            .int()
            .positive()
            .parse(
              (
                await tx.client.query(
                  `UPDATE ${relation(tx, 'tf_google_integrations')} SET ownership = 'personal', grants_version = grants_version + 1 WHERE id = $1 RETURNING grants_version`,
                  [row.id],
                )
              ).rows[0]?.grants_version,
            );
          return {
            integrationId: row.id,
            grantsVersion: nextVersion,
            grants: [],
          };
        }
        const seen = new Set<string>();
        const memberIds: string[] = [];
        const teamIds: string[] = [];
        for (const grant of parsed.grants) {
          const key = granteeKey(grant);
          if (seen.has(key)) throw new GoogleWorkspaceError('invalid-grant');
          seen.add(key);
          if (grant.kind === 'member') memberIds.push(grant.membershipId);
          if (grant.kind === 'team') teamIds.push(grant.teamId);
        }
        if (memberIds.length > 0) {
          const found = z.number().parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_memberships')}
                   WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`,
                [memberIds],
              )
            ).rows[0]?.count,
          );
          if (found !== memberIds.length) throw new GoogleWorkspaceError('invalid-grant');
        }
        if (teamIds.length > 0) {
          const found = z.number().parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_teams')}
                   WHERE id = ANY($1::uuid[])`,
                [teamIds],
              )
            ).rows[0]?.count,
          );
          if (found !== teamIds.length) throw new GoogleWorkspaceError('invalid-grant');
        }
        const manageWorkspace = parsed.grants.some(grant => grant.kind === 'workspace' && grant.role === 'manage');
        const manageMember = parsed.grants.some(grant => grant.kind === 'member' && grant.role === 'manage');
        const manageTeamIds = parsed.grants
          .filter(
            (grant): grant is Extract<GoogleGrantTarget, { kind: 'team' }> =>
              grant.kind === 'team' && grant.role === 'manage',
          )
          .map(grant => grant.teamId);
        let hasActiveManager = manageWorkspace || manageMember;
        if (!hasActiveManager && manageTeamIds.length > 0) {
          const activeInTeam = z.number().parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count
                   FROM ${relation(tx, 'tf_member_teams')} mt
                   JOIN ${relation(tx, 'tf_memberships')} m ON m.id = mt.membership_id AND m.removed_at IS NULL
                   WHERE mt.team_id = ANY($1::uuid[])`,
                [manageTeamIds],
              )
            ).rows[0]?.count,
          );
          hasActiveManager = activeInTeam > 0;
        }
        if (!hasActiveManager) throw new GoogleWorkspaceError('invalid-grant');
        await tx.client.query(`DELETE FROM ${relation(tx, 'tf_google_grants')} WHERE integration_id = $1`, [row.id]);
        for (const grant of parsed.grants) {
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_google_grants')} (integration_id, grantee, membership_id, team_id, role, granted_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              row.id,
              granteeKey(grant),
              grant.kind === 'member' ? grant.membershipId : null,
              grant.kind === 'team' ? grant.teamId : null,
              grant.role,
              actor.membershipId,
            ],
          );
        }
        const nextVersion = z
          .number()
          .int()
          .positive()
          .parse(
            (
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_google_integrations')} SET ownership = 'shared', grants_version = grants_version + 1 WHERE id = $1 RETURNING grants_version`,
                [row.id],
              )
            ).rows[0]?.grants_version,
          );
        return {
          integrationId: row.id,
          grantsVersion: nextVersion,
          grants: parsed.grants,
        };
      });
    },
    async withCredential<T>(
      fence: GoogleExecutionFence,
      operation: (credential: { accessToken: string; signal: AbortSignal }, tx: AuthorizationTransaction) => Promise<T>,
    ): Promise<T> {
      const outcome = await authorized(fence.workspaceId, fence.actor, async (tx, actor) => {
        const row = await loadById(tx, uuidSchema.parse(fence.integrationId));
        const allowed = row ? (await googleAccountAccess(tx, actor, row)).canUse : false;
        if (
          !row ||
          !allowed ||
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
