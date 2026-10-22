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
import {
  canManageIntegration,
  integrationManagers,
  setIntegrationManagers,
  validateIntegrationRecipients,
  watchIntegrationRecommendations,
  type DefaultKnowledgeHook,
} from '@tulipfarm/integrations/authorization';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  AccountError,
  accountCallbackSchema,
  accountGrantsSchema,
  accountLimits,
  accountProtocolSchema,
  accountRowSchema,
  accountScopesSchema,
  accountUuidSchema,
  beginAccountSchema,
  oauthConfigurationSchema,
  storedTokensSchema,
  type AccountConfigurations,
  type AccountProtocol,
  type AccountRow,
} from './account-contracts.ts';
import {
  accountAuthorizationUrl,
  accountIdentity,
  configurationHash,
  exchangeAccountToken,
  hashAccountValue,
  rejectReflectedCredentials,
} from './account-provider.ts';
import { accountCredentialCipher } from './account-credentials.ts';
import { atlassianRecommendations } from './recommendations.ts';

export {
  AccountError,
  beginAccountSchema,
  accountGrantsSchema,
  accountProtocolSchema,
  accountCallbackSchema,
  accountUuidSchema,
  accountMetadataSchema,
  accountListSchema,
  accountAuthorizationSchema,
  accountCompletionSchema,
  accountDisconnectionSchema,
} from './account-contracts.ts';
export { accountConfigurations } from './account-provider.ts';
export type { AccountConfigurations } from './account-contracts.ts';
export type AccountRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export const atlassianAccountCompatibility = commonCompatibility;
const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_atlassian_${name}`);
const attemptSchema = z.object({
  account_id: z.uuid(),
  generation: z.number().int(),
  membership_id: z.uuid(),
  verifier: z.unknown(),
});

// Automatic Knowledge reads only through personal REST consent; these match the corpus provider's required read scopes.
const knowledgeScopes = { jira: 'read:jira-work', confluence: 'read:page:confluence' } as const;

export function createAtlassianAccounts(options: {
  runtime: AccountRuntime;
  configurations: AccountConfigurations;
  keyring: IntegrationKeyring;
  fetcher?: typeof fetch;
  defaultKnowledge?: DefaultKnowledgeHook;
}) {
  const configurations = z.partialRecord(accountProtocolSchema, oauthConfigurationSchema).parse(options.configurations);
  const cipher = accountCredentialCipher(options.keyring);
  const fetcher = options.fetcher ?? fetch;
  const binding = (workspaceId: string, row: AccountRow, purpose: 'tokens' | 'pkce') => ({
    workspaceId,
    accountId: row.id,
    protocol: row.protocol,
    generation: row.generation,
    purpose,
  });
  function config(protocol: AccountProtocol) {
    const value = configurations[protocol];
    if (!value) throw new AccountError('account-disabled');
    return value;
  }
  async function authorized<T>(
    workspaceId: string,
    principal: string | HumanActor,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
    mode: 'read' | 'write' = 'read',
  ) {
    return options.runtime.transaction(
      accountUuidSchema.parse(workspaceId),
      atlassianAccountCompatibility,
      async tx => {
        await lockAuthorization(tx, mode);
        const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
        await currentMember(tx, actor);
        return operation(tx, actor);
      },
    );
  }
  async function load(tx: AuthorizationTransaction, id: string, lock = false) {
    const row = accountRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT * FROM ${relation(tx, 'accounts')} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [
            z.uuid().parse(id),
          ])
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function capabilities(tx: AuthorizationTransaction, actor: HumanActor, row: AccountRow) {
    if (row.ownership === 'personal') {
      const owner = row.owner_membership_id === actor.membershipId;
      return { read: owner, manage: owner, use: owner };
    }
    const manage = await canManageIntegration(tx, actor, 'atlassian', row.id);
    const use =
      (
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'account_member_grants')} WHERE account_id=$1 AND membership_id=$2
      UNION ALL SELECT 1 FROM ${relation(tx, 'account_team_grants')} g JOIN ${qualified(tx.schema, 'tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.account_id=$1 AND mt.membership_id=$2 LIMIT 1`,
          [row.id, actor.membershipId],
        )
      ).rowCount === 1;
    return { read: manage || use, manage, use };
  }
  async function permit(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    row: AccountRow,
    action: 'read' | 'manage' | 'use',
  ) {
    if (!(await capabilities(tx, actor, row))[action]) throw new AccessDenied();
  }
  async function metadata(tx: AuthorizationTransaction, actor: HumanActor, row: AccountRow) {
    await permit(tx, actor, row, 'read');
    const configured = configurations[row.protocol];
    const enabled = !!configured;
    const changed = configured && configurationHash(row.protocol, configured) !== row.config_hash;
    const staleRefresh =
      row.state === 'refreshing' && row.refresh_started_at && row.refresh_started_at.getTime() < Date.now() - 30000;
    const state = changed || staleRefresh ? 'reconnect-required' : row.state;
    const access = await capabilities(tx, actor, row);
    return {
      id: row.id,
      protocol: row.protocol,
      ownership: row.ownership,
      state,
      configured: enabled,
      identity: row.identity,
      resources: row.resources,
      scopes: row.scopes,
      generation: row.generation,
      grantsVersion: row.grants_version,
      capabilities: { ...access, use: access.use && enabled && state === 'active' },
    };
  }
  async function audit(tx: AuthorizationTransaction, actor: HumanActor, id: string, operation: string) {
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), actor.membershipId, `atlassian-account.${operation}`, id],
    );
  }
  async function reserve(workspaceId: string, userId: string, sessionId: string, input: unknown, existingId?: string) {
    workspaceId = accountUuidSchema.parse(workspaceId);
    const value = beginAccountSchema.parse(input);
    const configuration = config(value.protocol);
    const state = `${z.uuid().parse(workspaceId)}.${randomBytes(32).toString('base64url')}`;
    const verifier = randomBytes(32).toString('base64url');
    return authorized(
      workspaceId,
      userId,
      async (tx, actor) => {
        let id: string = randomUUID();
        if (existingId) {
          const row = await load(tx, existingId, true);
          await permit(tx, actor, row, 'manage');
          if (row.protocol !== value.protocol || row.ownership !== value.ownership.kind)
            throw new AccountError('account-conflict');
          id = row.id;
          const recommendations = await watchIntegrationRecommendations(tx, id, () => atlassianRecommendations(tx, id));
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET generation=generation+1,state='authorizing',credential=NULL,expires_at=NULL,refresh_started_at=NULL,config_hash=$2 WHERE id=$1`,
            [id, configurationHash(value.protocol, configuration)],
          );
          await recommendations();
        } else {
          const counts = z.object({ total: z.number(), owned: z.number() }).parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE ownership=$1 AND ($1='business' OR owner_membership_id=$2))::integer AS owned FROM ${relation(tx, 'accounts')}`,
                [value.ownership.kind, actor.membershipId],
              )
            ).rows[0],
          );
          if (counts.total >= accountLimits.workspace || counts.owned >= accountLimits[value.ownership.kind])
            throw new AccountError('account-limit-reached');
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'accounts')} (id,protocol,ownership,owner_membership_id,state,config_hash) VALUES ($1,$2,$3,$4,'authorizing',$5)`,
            [
              id,
              value.protocol,
              value.ownership.kind,
              value.ownership.kind === 'personal' ? actor.membershipId : null,
              configurationHash(value.protocol, configuration),
            ],
          );
          if (value.ownership.kind === 'business') {
            await setIntegrationManagers(tx, actor, 'atlassian', id, { memberIds: [actor.membershipId], teamIds: [] });
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'account_member_grants')} (account_id,membership_id) VALUES ($1,$2)`,
              [id, actor.membershipId],
            );
          }
        }
        const row = await load(tx, id);
        const encrypted = cipher.encrypt(binding(workspaceId, row, 'pkce'), verifier);
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'account_attempts')} (account_id,generation,state_hash,session_hash,membership_id,state,verifier,expires_at)
        VALUES ($1,$2,$3,$4,$5,'reserved',$6,clock_timestamp()+interval '10 minutes')
        ON CONFLICT (account_id) DO UPDATE SET generation=EXCLUDED.generation,state_hash=EXCLUDED.state_hash,session_hash=EXCLUDED.session_hash,membership_id=EXCLUDED.membership_id,state='reserved',verifier=EXCLUDED.verifier,expires_at=EXCLUDED.expires_at`,
          [id, row.generation, hashAccountValue(state), hashAccountValue(sessionId), actor.membershipId, encrypted],
        );
        await audit(tx, actor, id, existingId ? 'reconnect' : 'begin');
        return { accountId: id, url: accountAuthorizationUrl(value.protocol, configuration, state, verifier) };
      },
      'write',
    );
  }
  async function invalidate(workspaceId: string, id: string, generation: number, state: 'authorizing' | 'refreshing') {
    await options.runtime.transaction(workspaceId, atlassianAccountCompatibility, async tx => {
      await lockAuthorization(tx);
      await load(tx, id, true);
      const recommendations = await watchIntegrationRecommendations(tx, id, () => atlassianRecommendations(tx, id));
      await tx.client.query(
        `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',credential=NULL,expires_at=NULL,refresh_started_at=NULL WHERE id=$1 AND generation=$2 AND state=$3`,
        [id, generation, state],
      );
      if (state === 'authorizing')
        await tx.client.query(
          `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1 AND generation=$2`,
          [id, generation],
        );
      await recommendations();
    });
  }
  return {
    async list(workspaceId: string, userId: string) {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const rows = z
          .array(accountRowSchema)
          .max(accountLimits.workspace)
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${relation(tx, 'accounts')} WHERE ownership='business' OR owner_membership_id=$1 ORDER BY created_at,id LIMIT $2`,
                [actor.membershipId, accountLimits.workspace + 1],
              )
            ).rows,
          );
        const accounts = [];
        for (const row of rows)
          if ((await capabilities(tx, actor, row)).read) accounts.push(await metadata(tx, actor, row));
        return {
          accounts,
          providers: accountProtocolSchema.options.map(protocol => ({
            protocol,
            configured: !!configurations[protocol],
          })),
        };
      });
    },
    async status(workspaceId: string, userId: string, id: string) {
      return authorized(workspaceId, userId, async (tx, actor) => metadata(tx, actor, await load(tx, id)));
    },
    begin(workspaceId: string, userId: string, sessionId: string, input: unknown) {
      return reserve(workspaceId, userId, sessionId, input);
    },
    async reconnect(workspaceId: string, userId: string, sessionId: string, id: string) {
      const row = await authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, id);
        await permit(tx, actor, row, 'manage');
        return row;
      });
      return reserve(
        workspaceId,
        userId,
        sessionId,
        { protocol: row.protocol, ownership: { kind: row.ownership } },
        id,
      );
    },
    async complete(code: string | null, state: string, sessionId: string, userId: string) {
      const callback = accountCallbackSchema.parse(code === null ? { error: 'access_denied', state } : { code, state });
      const workspaceId = accountUuidSchema.parse(callback.state.slice(0, 36));
      const prepared = await authorized(workspaceId, userId, async (tx, actor) => {
        const attempt = attemptSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${relation(tx, 'account_attempts')} WHERE state_hash=$1 AND session_hash=$2 AND membership_id=$3 AND state='reserved' AND expires_at>clock_timestamp()`,
                [hashAccountValue(state), hashAccountValue(sessionId), actor.membershipId],
              )
            ).rows[0],
          );
        if (!attempt) throw new AccessDenied();
        const row = await load(tx, attempt.account_id, true);
        await permit(tx, actor, row, 'manage');
        if (row.generation !== attempt.generation || row.state !== 'authorizing')
          throw new AccountError('account-conflict');
        if (!('code' in callback)) {
          const consumed = await tx.client.query(
            `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1 AND generation=$2 AND state_hash=$3 AND state='reserved' AND expires_at>clock_timestamp() RETURNING account_id`,
            [row.id, row.generation, hashAccountValue(state)],
          );
          if (!consumed.rowCount) throw new AccountError('account-conflict');
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',credential=NULL,expires_at=NULL WHERE id=$1`,
            [row.id],
          );
          await audit(tx, actor, row.id, 'authorization-denied');
          return null;
        }
        const configuration = config(row.protocol);
        if (row.config_hash !== configurationHash(row.protocol, configuration))
          throw new AccountError('account-conflict');
        const claimed = await tx.client.query(
          `UPDATE ${relation(tx, 'account_attempts')} SET state='exchanging',verifier=NULL WHERE account_id=$1 AND generation=$2 AND state_hash=$3 AND state='reserved' AND expires_at>clock_timestamp() RETURNING account_id`,
          [row.id, row.generation, hashAccountValue(state)],
        );
        if (!claimed.rowCount) throw new AccountError('account-conflict');
        return {
          row,
          actor,
          configuration,
          verifier: cipher.decrypt(binding(workspaceId, row, 'pkce'), attempt.verifier),
        };
      });
      if (!prepared || !('code' in callback)) throw new AccountError('account-authorization-denied');
      try {
        const token = await exchangeAccountToken(
          prepared.row.protocol,
          prepared.configuration,
          { kind: 'code', code: callback.code, verifier: prepared.verifier },
          fetcher,
        );
        const scopes = accountScopesSchema.parse(
          token.scope === undefined ? prepared.configuration.scopes : token.scope.split(/\s+/).filter(Boolean),
        );
        if (prepared.configuration.scopes.some(scope => !scopes.includes(scope)))
          throw new AccountError('account-reconnect-required');
        const identity = await accountIdentity(prepared.row.protocol, token.access_token, randomUUID(), fetcher);
        rejectReflectedCredentials({ ...identity, scopes }, [
          token.access_token,
          token.refresh_token ?? '',
          prepared.configuration.clientSecret,
          callback.code,
          state,
          prepared.verifier,
        ]);
        if (prepared.row.identity?.qualification === 'verified' && prepared.row.identity.id !== identity.identity.id)
          throw new AccountError('account-conflict');
        const eligible =
          prepared.row.protocol === 'atlassian-rest' &&
          prepared.row.ownership === 'personal' &&
          prepared.row.identity === null &&
          identity.identity.qualification === 'verified';
        const automatic =
          eligible && options.defaultKnowledge && (await options.defaultKnowledge.enabled(workspaceId, userId))
            ? options.defaultKnowledge
            : undefined;
        const intents: string[] = [];
        const completed = await authorized(workspaceId, prepared.actor, async (tx, actor) => {
          const row = await load(tx, prepared.row.id, true);
          await permit(tx, actor, row, 'manage');
          if (row.generation !== prepared.row.generation || row.state !== 'authorizing')
            throw new AccountError('account-conflict');
          const credential = cipher.encrypt(
            binding(workspaceId, row, 'tokens'),
            JSON.stringify({ accessToken: token.access_token, refreshToken: token.refresh_token ?? null }),
          );
          const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
            atlassianRecommendations(tx, row.id),
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET state='active',identity=$2,resources=$3,scopes=$4,credential=$5,expires_at=clock_timestamp()+$6*interval '1 second' WHERE id=$1`,
            [row.id, identity.identity, JSON.stringify(identity.resources), scopes, credential, token.expires_in],
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1 AND generation=$2`,
            [row.id, row.generation],
          );
          await audit(tx, actor, row.id, 'connected');
          await recommendations();
          if (automatic && row.identity === null) {
            const granted = new Set([...scopes, ...identity.resources.flatMap(resource => resource.scopes)]);
            for (const product of ['jira', 'confluence'] as const) {
              if (!granted.has(knowledgeScopes[product])) continue;
              const recorded = await automatic.record(tx, {
                product,
                membershipId: actor.membershipId,
                accountKey: row.id,
                accountLabel: identity.identity.label,
              });
              if (recorded.created) intents.push(recorded.intentId);
            }
          }
          return { workspaceId, account: await metadata(tx, actor, await load(tx, row.id)) };
        });
        if (automatic && intents.length) automatic.started?.(workspaceId, intents);
        return completed;
      } catch {
        await invalidate(workspaceId, prepared.row.id, prepared.row.generation, 'authorizing');
        throw new AccountError('account-reconnect-required');
      }
    },
    async disconnect(workspaceId: string, userId: string, id: string) {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, id, true);
        await permit(tx, actor, row, 'manage');
        const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
          atlassianRecommendations(tx, row.id),
        );
        await tx.client.query(
          `UPDATE ${relation(tx, 'accounts')} SET state='disconnected',generation=generation+1,credential=NULL,expires_at=NULL,refresh_started_at=NULL WHERE id=$1`,
          [row.id],
        );
        await tx.client.query(
          `UPDATE ${relation(tx, 'account_attempts')} SET state='consumed',verifier=NULL WHERE account_id=$1`,
          [row.id],
        );
        await audit(tx, actor, row.id, 'disconnect');
        await recommendations();
        return { account: await metadata(tx, actor, await load(tx, id)), providerRevocation: 'manual-required' };
      });
    },
    async setGrants(workspaceId: string, userId: string, id: string, input: unknown) {
      const value = accountGrantsSchema.parse(input);
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, id, true);
        await permit(tx, actor, row, 'manage');
        if (row.ownership !== 'business') throw new AccessDenied();
        if (row.grants_version !== value.expectedVersion) throw new AccountError('account-conflict');
        const before = await metadata(tx, actor, row);
        const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
          atlassianRecommendations(tx, row.id),
        );
        await validateIntegrationRecipients(
          tx,
          actor,
          value,
          z
            .array(z.object({ team_id: z.uuid() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT team_id FROM ${relation(tx, 'account_team_grants')} WHERE account_id=$1`,
                  [row.id],
                )
              ).rows,
            )
            .map(grant => grant.team_id),
        );
        if (value.managers) await setIntegrationManagers(tx, actor, 'atlassian', id, value.managers);
        await tx.client.query(`DELETE FROM ${relation(tx, 'account_member_grants')} WHERE account_id=$1`, [row.id]);
        await tx.client.query(`DELETE FROM ${relation(tx, 'account_team_grants')} WHERE account_id=$1`, [row.id]);
        for (const memberId of new Set(value.memberIds))
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'account_member_grants')} (account_id,membership_id) VALUES ($1,$2)`,
            [row.id, memberId],
          );
        for (const teamId of new Set(value.teamIds))
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'account_team_grants')} (account_id,team_id) VALUES ($1,$2)`,
            [row.id, teamId],
          );
        await tx.client.query(`UPDATE ${relation(tx, 'accounts')} SET grants_version=grants_version+1 WHERE id=$1`, [
          row.id,
        ]);
        await audit(tx, actor, row.id, 'grants');
        await recommendations();
        const updated = await load(tx, id);
        const access = await capabilities(tx, actor, updated);
        return access.read
          ? metadata(tx, actor, updated)
          : { ...before, capabilities: access, grantsVersion: updated.grants_version };
      });
    },
    async grants(workspaceId: string, userId: string, id: string) {
      return authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, id);
        await permit(tx, actor, row, 'manage');
        if (row.ownership !== 'business') throw new AccessDenied();
        const memberIds = z
          .array(z.object({ membership_id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT membership_id FROM ${relation(tx, 'account_member_grants')} WHERE account_id=$1 ORDER BY membership_id`,
                [row.id],
              )
            ).rows,
          )
          .map(row => row.membership_id);
        const teamIds = z
          .array(z.object({ team_id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT team_id FROM ${relation(tx, 'account_team_grants')} WHERE account_id=$1 ORDER BY team_id`,
                [row.id],
              )
            ).rows,
          )
          .map(row => row.team_id);
        return {
          expectedVersion: row.grants_version,
          memberIds,
          teamIds,
          managers: await integrationManagers(tx, 'atlassian', id),
        };
      });
    },
    async withAccessToken<T>(
      workspaceId: string,
      userId: string | HumanActor,
      id: string,
      operation: (credential: {
        protocol: AccountProtocol;
        accessToken: string;
        generation: number;
        grantsVersion: number;
        membershipId: string;
      }) => Promise<T>,
    ): Promise<T> {
      workspaceId = accountUuidSchema.parse(workspaceId);
      const prepared = await authorized(workspaceId, userId, async (tx, actor) => {
        const row = await load(tx, id, true);
        await permit(tx, actor, row, 'use');
        const configuration = config(row.protocol);
        if (configurationHash(row.protocol, configuration) !== row.config_hash)
          throw new AccountError('account-reconnect-required');
        if (row.state === 'refreshing') {
          if (row.refresh_started_at && row.refresh_started_at.getTime() < Date.now() - 30000) {
            const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
              atlassianRecommendations(tx, row.id),
            );
            await tx.client.query(
              `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',credential=NULL,expires_at=NULL,refresh_started_at=NULL WHERE id=$1`,
              [row.id],
            );
            await recommendations();
            return { kind: 'blocked' as const };
          }
          throw new AccountError('account-refresh-in-progress');
        }
        if (row.state !== 'active') throw new AccountError('account-reconnect-required');
        const tokens = storedTokensSchema.parse(
          JSON.parse(cipher.decrypt(binding(workspaceId, row, 'tokens'), row.credential)),
        );
        if (row.expires_at && row.expires_at.getTime() > Date.now() + 60000)
          return { kind: 'ready' as const, row, actor, tokens };
        if (!tokens.refreshToken) {
          const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
            atlassianRecommendations(tx, row.id),
          );
          await tx.client.query(
            `UPDATE ${relation(tx, 'accounts')} SET state='reconnect-required',credential=NULL,expires_at=NULL WHERE id=$1`,
            [row.id],
          );
          await recommendations();
          return { kind: 'blocked' as const };
        }
        await tx.client.query(
          `UPDATE ${relation(tx, 'accounts')} SET state='refreshing',refresh_started_at=clock_timestamp() WHERE id=$1`,
          [row.id],
        );
        return { kind: 'refresh' as const, row, actor, configuration, refreshToken: tokens.refreshToken };
      });
      if (prepared.kind === 'blocked') throw new AccountError('account-reconnect-required');
      let generation = prepared.row.generation;
      if (prepared.kind === 'refresh') {
        try {
          const token = await exchangeAccountToken(
            prepared.row.protocol,
            prepared.configuration,
            { kind: 'refresh', token: prepared.refreshToken },
            fetcher,
          );
          if (!token.refresh_token) throw new AccountError('account-reconnect-required');
          const scopes = accountScopesSchema.parse(
            token.scope === undefined ? prepared.row.scopes : token.scope.split(/\s+/).filter(Boolean),
          );
          rejectReflectedCredentials(scopes, [
            token.access_token,
            token.refresh_token,
            prepared.refreshToken,
            prepared.configuration.clientSecret,
          ]);
          if (prepared.configuration.scopes.some(scope => !scopes.includes(scope)))
            throw new AccountError('account-reconnect-required');
          generation = await authorized(workspaceId, prepared.actor, async (tx, actor) => {
            const row = await load(tx, id, true);
            await permit(tx, actor, row, 'use');
            if (row.generation !== prepared.row.generation || row.state !== 'refreshing')
              throw new AccountError('account-conflict');
            const next = { ...row, generation: row.generation + 1 };
            const credential = cipher.encrypt(
              binding(workspaceId, next, 'tokens'),
              JSON.stringify({ accessToken: token.access_token, refreshToken: token.refresh_token }),
            );
            const recommendations = await watchIntegrationRecommendations(tx, row.id, () =>
              atlassianRecommendations(tx, row.id),
            );
            await tx.client.query(
              `UPDATE ${relation(tx, 'accounts')} SET generation=$2,state='active',credential=$3,scopes=$4,expires_at=clock_timestamp()+$5*interval '1 second',refresh_started_at=NULL WHERE id=$1`,
              [row.id, next.generation, credential, scopes, token.expires_in],
            );
            await recommendations();
            return next.generation;
          });
        } catch {
          await invalidate(workspaceId, id, prepared.row.generation, 'refreshing');
          throw new AccountError('account-reconnect-required');
        }
      }
      return authorized(workspaceId, prepared.actor, async (tx, actor) => {
        const row = await load(tx, id, true);
        await permit(tx, actor, row, 'use');
        if (
          row.generation !== generation ||
          row.state !== 'active' ||
          !row.expires_at ||
          row.expires_at.getTime() <= Date.now()
        )
          throw new AccountError('account-reconnect-required');
        const tokens = storedTokensSchema.parse(
          JSON.parse(cipher.decrypt(binding(workspaceId, row, 'tokens'), row.credential)),
        );
        return operation({
          protocol: row.protocol,
          accessToken: tokens.accessToken,
          generation: row.generation,
          grantsVersion: row.grants_version,
          membershipId: actor.membershipId,
        });
      });
    },
  };
}
