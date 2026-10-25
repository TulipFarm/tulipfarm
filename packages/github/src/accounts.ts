import { randomBytes, randomUUID } from 'node:crypto';
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
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  accountSchema,
  accountStateSchema,
  callbackSchema,
  GitHubAccountError,
  GitHubCredentialRejected,
  identitySchema,
  scopesSchema,
  uuidSchema,
} from './contracts.ts';
import {
  authorizationUrl,
  configurationHash,
  configurationSchema,
  exchange,
  hash,
  identity,
  refresh,
  type Configuration,
} from './provider.ts';
import { credentialCipher } from './credentials.ts';
import { watchIntegrationRecommendations, type DefaultKnowledgeHook } from '@tulipfarm/integrations/authorization';
import { githubRecommendations } from './recommendations.ts';

export { githubConfiguration } from './provider.ts';
export { GitHubAccountError, GitHubCredentialRejected } from './contracts.ts';
export type AccountRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export const githubCompatibility = commonCompatibility;
const rowSchema = z.object({
  id: z.uuid(),
  owner_membership_id: z.uuid(),
  generation: z.number().int().positive(),
  state: accountStateSchema,
  config_hash: z.string(),
  identity: identitySchema.nullable(),
  scopes: scopesSchema,
  credential: z.unknown(),
  expires_at: z.date().nullable(),
  refresh_credential: z.unknown(),
  access_expires_at: z.date().nullable(),
});
type Row = z.infer<typeof rowSchema>;
const attemptSchema = z.object({
  account_id: z.uuid(),
  generation: z.number().int().positive(),
  verifier: z.unknown(),
});
const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_github_${name}`);
export type GitHubCredential = {
  accessToken: string;
  accountId: string;
  membershipId: string;
  generation: number;
  identity: z.infer<typeof identitySchema>;
  scopes: string[];
};

export function createGitHubAccounts(options: {
  runtime: AccountRuntime;
  configuration: Configuration | null;
  keyring: IntegrationKeyring | null;
  installUrl?: string | null;
  fetcher?: typeof fetch;
  defaultKnowledge?: DefaultKnowledgeHook;
}) {
  const configuration = options.configuration === null ? null : configurationSchema.parse(options.configuration);
  if (configuration && !options.keyring) throw new Error('GitHub credentials require an encryption keyring');
  const cipher = options.keyring ? credentialCipher(options.keyring) : null;
  const fetcher = options.fetcher ?? fetch;
  const binding = (workspaceId: string, row: Row, purpose: 'token' | 'pkce' | 'refresh') => ({
    workspaceId,
    accountId: row.id,
    membershipId: row.owner_membership_id,
    generation: row.generation,
    purpose,
  });
  function enabled() {
    if (!configuration || !cipher) throw new GitHubAccountError('account-disabled');
    return { configuration, cipher };
  }
  async function authorized<T>(
    workspaceId: string,
    principal: string | HumanActor,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
    mode: 'read' | 'write' = 'read',
  ) {
    return options.runtime.transaction(uuidSchema.parse(workspaceId), githubCompatibility, async tx => {
      await lockAuthorization(tx, mode);
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  async function load(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
    const row = rowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'accounts')} WHERE id=$1 AND owner_membership_id=$2 FOR UPDATE`,
            [uuidSchema.parse(id), actor.membershipId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  function metadata(row: Row) {
    const expired = row.expires_at !== null && row.expires_at.getTime() <= Date.now();
    const changed = configuration !== null && row.config_hash !== configurationHash(configuration);
    return accountSchema.parse({
      id: row.id,
      state: row.state === 'active' && (expired || changed) ? 'reconnect-required' : row.state,
      configured: configuration !== null,
      identity: row.identity,
      generation: row.generation,
      scopes: row.scopes,
    });
  }
  async function audit(tx: AuthorizationTransaction, actor: HumanActor, id: string, operation: string) {
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), actor.membershipId, `github-account.${operation}`, id],
    );
  }
  async function reserve(workspaceId: string, userId: string, sessionId: string, existingId?: string) {
    workspaceId = uuidSchema.parse(workspaceId);
    const { configuration, cipher } = enabled();
    const state = `${workspaceId}.${randomBytes(32).toString('base64url')}`;
    const verifier = randomBytes(32).toString('base64url');
    return authorized(
      workspaceId,
      userId,
      async (tx, actor) => {
        let id: string = randomUUID();
        if (existingId) {
          const row = await load(tx, actor, existingId);
          id = row.id;
          const recommendations = await watchIntegrationRecommendations(tx, id, () => githubRecommendations(tx, id));
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET generation=generation+1,state='authorizing',credential=NULL,refresh_credential=NULL,access_expires_at=NULL,expires_at=NULL,config_hash=$2 WHERE id=$1`,
            [id, configurationHash(configuration)],
          );
          await recommendations();
        } else {
          const counts = z
            .object({ total: z.number(), owned: z.number() })
            .parse(
              (
                await tx.client.query(
                  `SELECT count(*)::integer AS total, count(*) FILTER (WHERE owner_membership_id=$1)::integer AS owned FROM ${relation(tx, 'accounts')}`,
                  [actor.membershipId],
                )
              ).rows[0],
            );
          if (counts.total >= 100 || counts.owned >= 20) throw new GitHubAccountError('account-limit-reached');
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'accounts')} (id,owner_membership_id,state,config_hash) VALUES ($1,$2,'authorizing',$3)`,
            [id, actor.membershipId, configurationHash(configuration)],
          );
        }
        const row = await load(tx, actor, id);
        const encrypted = cipher.encrypt(binding(workspaceId, row, 'pkce'), verifier);
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'account_attempts')} (account_id,generation,state_hash,session_hash,membership_id,state,verifier,expires_at)
        VALUES ($1,$2,$3,$4,$5,'reserved',$6,clock_timestamp()+interval '10 minutes')
        ON CONFLICT (account_id) DO UPDATE SET generation=EXCLUDED.generation,state_hash=EXCLUDED.state_hash,session_hash=EXCLUDED.session_hash,membership_id=EXCLUDED.membership_id,state='reserved',verifier=EXCLUDED.verifier,expires_at=EXCLUDED.expires_at`,
          [id, row.generation, hash(state), hash(z.string().min(1).parse(sessionId)), actor.membershipId, encrypted],
        );
        await audit(tx, actor, id, existingId ? 'reconnect' : 'begin');
        return { accountId: id, url: authorizationUrl(configuration, state, verifier) };
      },
      'write',
    );
  }
  async function invalidate(workspaceId: string, row: Row) {
    await options.runtime.transaction(workspaceId, githubCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',credential=NULL,refresh_credential=NULL,access_expires_at=NULL,expires_at=NULL WHERE id=$1 AND generation=$2 AND state='authorizing'`,
        [row.id, row.generation],
      );
      await tx.client.query(
        `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1 AND generation=$2`,
        [row.id, row.generation],
      );
    });
  }
  const accounts = {
    async list(workspaceId: string, userId: string) {
      return authorized(workspaceId, userId, async (tx, actor) => ({
        configured: configuration !== null,
        installUrl: options.installUrl ?? null,
        accounts: z
          .array(rowSchema)
          .max(20)
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${relation(tx, 'accounts')} WHERE owner_membership_id=$1 ORDER BY created_at,id LIMIT 21`,
                [actor.membershipId],
              )
            ).rows,
          )
          .map(metadata),
      }));
    },
    async status(workspaceId: string, userId: string, id: string) {
      return authorized(workspaceId, userId, async (tx, actor) => metadata(await load(tx, actor, id)));
    },
    begin(workspaceId: string, userId: string, sessionId: string) {
      return reserve(workspaceId, userId, sessionId);
    },
    reconnect(workspaceId: string, userId: string, sessionId: string, id: string) {
      return reserve(workspaceId, userId, sessionId, id);
    },
    async complete(input: unknown, sessionId: string, userId: string) {
      const callback = callbackSchema.parse(input);
      const workspaceId = uuidSchema.parse(callback.state.slice(0, 36));
      const { configuration, cipher } = enabled();
      const prepared = await authorized(workspaceId, userId, async (tx, actor) => {
        const attempt = attemptSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${relation(tx, 'account_attempts')} WHERE state_hash=$1 AND session_hash=$2 AND membership_id=$3 AND state='reserved' AND expires_at>clock_timestamp()`,
                [hash(callback.state), hash(sessionId), actor.membershipId],
              )
            ).rows[0],
          );
        if (!attempt) throw new AccessDenied();
        const row = await load(tx, actor, attempt.account_id);
        if (
          row.generation !== attempt.generation ||
          row.state !== 'authorizing' ||
          row.config_hash !== configurationHash(configuration)
        )
          throw new GitHubAccountError('account-conflict');
        const claimed = await tx.client.query(
          `UPDATE ${relation(tx, 'account_attempts')} SET state=$4,verifier=NULL WHERE account_id=$1 AND generation=$2 AND state_hash=$3 AND state='reserved' AND expires_at>clock_timestamp() RETURNING account_id`,
          [row.id, row.generation, hash(callback.state), 'code' in callback ? 'exchanging' : 'consumed'],
        );
        if (!claimed.rowCount) throw new GitHubAccountError('account-conflict');
        if (!('code' in callback)) {
          await tx.client.query(`UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required' WHERE id=$1`, [
            row.id,
          ]);
          await audit(tx, actor, row.id, 'authorization-denied');
          return null;
        }
        return { row, actor, verifier: cipher.decrypt(binding(workspaceId, row, 'pkce'), attempt.verifier) };
      });
      if (!prepared || !('code' in callback)) throw new GitHubAccountError('account-authorization-denied');
      try {
        const token = await exchange(configuration, callback.code, prepared.verifier, fetcher);
        const who = await identity(token.accessToken, fetcher);
        const publicValues = JSON.stringify({ who, scopes: token.scopes });
        const secrets = [
          token.accessToken,
          configuration.clientSecret,
          callback.code,
          callback.state,
          prepared.verifier,
        ];
        if (
          secrets
            .flatMap(secret => [
              secret,
              Buffer.from(secret).toString('base64'),
              Buffer.from(secret).toString('base64url'),
            ])
            .some(secret => publicValues.includes(secret))
        )
          throw new GitHubAccountError('account-unavailable');
        if (prepared.row.identity && prepared.row.identity.id !== who.id)
          throw new GitHubAccountError('account-conflict');
        // Only the first authorization of an account is a new enablement; reconnects keep their identity.
        // GitHub Knowledge is not behind the feature flag: every new account starts indexing.
        const automatic = prepared.row.identity === null ? options.defaultKnowledge : undefined;
        let intent: string | null = null;
        const completed = await authorized(workspaceId, prepared.actor, async (tx, actor) => {
          const row = await load(tx, actor, prepared.row.id);
          if (row.generation !== prepared.row.generation || row.state !== 'authorizing')
            throw new GitHubAccountError('account-conflict');
          const credential = cipher.encrypt(binding(workspaceId, row, 'token'), token.accessToken);
          const refreshCredential = token.refreshToken
            ? cipher.encrypt(binding(workspaceId, row, 'refresh'), token.refreshToken)
            : null;
          const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
            githubRecommendations(tx, row.id),
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET state='active',identity=$2,scopes=$3,credential=$4,refresh_credential=$6,access_expires_at=CASE WHEN $6::jsonb IS NULL OR $5::integer IS NULL THEN NULL ELSE clock_timestamp()+$5*interval '1 second' END,expires_at=CASE WHEN COALESCE($7::integer,$5::integer) IS NULL THEN NULL ELSE clock_timestamp()+COALESCE($7::integer,$5::integer)*interval '1 second' END WHERE id=$1`,
            [row.id, who, token.scopes, credential, token.expiresIn, refreshCredential, token.refreshExpiresIn],
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1 AND generation=$2`,
            [row.id, row.generation],
          );
          await audit(tx, actor, row.id, 'connected');
          await recommendations();
          if (automatic && row.identity === null) {
            const recorded = await automatic.record(tx, {
              product: 'github',
              membershipId: actor.membershipId,
              accountKey: row.id,
              accountLabel: who.login,
            });
            if (recorded.created) intent = recorded.intentId;
          }
          return { workspaceId, account: metadata(await load(tx, actor, row.id)) };
        });
        if (automatic && intent) automatic.started?.(workspaceId, [intent]);
        return completed;
      } catch {
        await invalidate(workspaceId, prepared.row);
        throw new GitHubAccountError('account-reconnect-required');
      }
    },
    async disconnect(workspaceId: string, userId: string, id: string) {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, actor, id);
        if (row.state !== 'disconnected') {
          const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
            githubRecommendations(tx, row.id),
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET state='disconnected',generation=generation+1,credential=NULL,refresh_credential=NULL,access_expires_at=NULL,expires_at=NULL WHERE id=$1`,
            [row.id],
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1`,
            [row.id],
          );
          await audit(tx, actor, row.id, 'disconnect');
          await recommendations();
        }
        return { account: metadata(await load(tx, actor, id)), providerRevocation: 'manual-required' as const };
      });
    },
    async withCredential<T>(
      workspaceId: string,
      principal: string | HumanActor,
      id: string,
      operation: (credential: GitHubCredential, tx: AuthorizationTransaction) => Promise<T>,
      expectedGeneration?: number,
      beforeAccount?: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<void>,
    ): Promise<T> {
      workspaceId = uuidSchema.parse(workspaceId);
      const { configuration, cipher } = enabled();
      const staleAccess = (row: Row, margin: number) =>
        row.refresh_credential !== null &&
        row.access_expires_at !== null &&
        row.access_expires_at.getTime() <= Date.now() + margin;
      const reject = async (tx: AuthorizationTransaction, actor: HumanActor, row: Row) => {
        const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
          githubRecommendations(tx, row.id),
        );
        await tx.client.query(
          `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',generation=generation+1,credential=NULL,refresh_credential=NULL,access_expires_at=NULL,expires_at=NULL WHERE id=$1`,
          [row.id],
        );
        await audit(tx, actor, row.id, 'credential-rejected');
        await recommendations();
        return { kind: 'rejected' as const };
      };
      const available = (row: Row) =>
        row.state === 'active' &&
        row.identity !== null &&
        (expectedGeneration === undefined || row.generation === expectedGeneration);
      // A refresh token is single-use, so the row lock held here serializes concurrent refreshes. It keeps
      // `generation` unchanged because Knowledge bindings, selections and batches are pinned to it.
      const renew = () =>
        authorized(workspaceId, principal, async (tx, actor) => {
          const row = await load(tx, actor, id);
          if (!available(row) || !row.refresh_credential) throw new GitHubAccountError('account-reconnect-required');
          if (!staleAccess(row, 30 * 60 * 1000)) return { kind: 'renewed' as const };
          let renewed: Awaited<ReturnType<typeof refresh>>;
          try {
            renewed = await refresh(
              configuration,
              cipher.decrypt(binding(workspaceId, row, 'refresh'), row.refresh_credential),
              fetcher,
            );
          } catch (error) {
            if (error instanceof GitHubCredentialRejected) return reject(tx, actor, row);
            throw error;
          }
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET credential=$2,refresh_credential=$3,access_expires_at=clock_timestamp()+$4*interval '1 second',expires_at=clock_timestamp()+$5*interval '1 second' WHERE id=$1`,
            [
              row.id,
              cipher.encrypt(binding(workspaceId, row, 'token'), renewed.accessToken),
              cipher.encrypt(binding(workspaceId, row, 'refresh'), renewed.refreshToken),
              renewed.expiresIn,
              renewed.refreshExpiresIn,
            ],
          );
          return { kind: 'renewed' as const };
        });
      for (let renewals = 0; ; renewals++) {
        const result = await authorized(workspaceId, principal, async (tx, actor) => {
          await beforeAccount?.(tx, actor);
          const row = await load(tx, actor, id);
          if (!available(row)) throw new GitHubAccountError('account-reconnect-required');
          if (
            row.config_hash !== configurationHash(configuration) ||
            (row.expires_at && row.expires_at.getTime() <= Date.now())
          )
            return reject(tx, actor, row);
          if (renewals === 0 && staleAccess(row, 30 * 60 * 1000)) return { kind: 'renew' as const };
          const accessToken = cipher.decrypt(binding(workspaceId, row, 'token'), row.credential);
          try {
            return {
              kind: 'success' as const,
              value: await operation(
                {
                  accessToken,
                  accountId: row.id,
                  membershipId: actor.membershipId,
                  generation: row.generation,
                  identity: row.identity!,
                  scopes: row.scopes,
                },
                tx,
              ),
            };
          } catch (error) {
            if (error instanceof GitHubCredentialRejected) return reject(tx, actor, row);
            throw error;
          }
        });
        if (result.kind === 'renew') {
          if ((await renew()).kind === 'rejected') throw new GitHubAccountError('account-reconnect-required');
          continue;
        }
        if (result.kind === 'rejected') throw new GitHubAccountError('account-reconnect-required');
        return result.value;
      }
    },
    // Use only with a top-level runtime: caller-bound transactions cannot release their outer locks.
    async withReadCredential<T>(
      workspaceId: string,
      principal: string | HumanActor,
      id: string,
      operation: (credential: GitHubCredential) => Promise<T>,
      expectedGeneration?: number,
      requireAccess?: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<void>,
    ): Promise<T> {
      const credential = await accounts.withCredential(
        workspaceId,
        principal,
        id,
        async credential => credential,
        expectedGeneration,
        requireAccess,
      );
      const actor: HumanActor = {
        kind: 'human',
        userId: typeof principal === 'string' ? principal : principal.userId,
        membershipId: credential.membershipId,
      };
      let outcome: { kind: 'success'; value: T } | { kind: 'failure'; error: unknown };
      try {
        outcome = { kind: 'success', value: await operation(credential) };
      } catch (error) {
        outcome = { kind: 'failure', error };
      }
      return accounts.withCredential(
        workspaceId,
        actor,
        id,
        async () => {
          if (outcome.kind === 'failure') throw outcome.error;
          return outcome.value;
        },
        credential.generation,
        requireAccess,
      );
    },
  };
  return accounts;
}
