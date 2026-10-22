import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import {
  currentMember,
  lockAuthorization,
  resolveHuman,
  AccessDenied,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, type createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { slackConfigurationSchema, slackId, type SlackConfiguration } from './contracts.ts';
import { slackCredentialCipher, encryptSlackToken, storedCredentialSchema } from './credentials.ts';
import { exchangeCode } from './provider.ts';
import { canAccessSlackInstallation } from './installation-access.ts';
import { callSlackApi, SlackApiError } from './web-api.ts';
import { watchIntegrationRecommendations } from '@tulipfarm/integrations/authorization';
import { slackRecommendations } from './recommendations.ts';

export type SlackRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export const slackCompatibility = commonCompatibility;
// Installation management reads 0109 manager and use-grant tables.
const managementCompatibility = slackCompatibility;
const linkSchema = z.object({
  workspace_id: z.uuid(),
  installation_id: z.uuid(),
  app_id: slackId,
  generation: z.number().int(),
  state: z.enum(['reserved', 'authorizing', 'active', 'failed', 'revoked']),
  team_id: slackId.nullable(),
  session_id: z.string(),
  user_id: z.string(),
  membership_id: z.uuid(),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const channelPageLimit = 10;

export function createSlackInstallations(options: {
  pool: Pick<Pool, 'query'>;
  runtime: SlackRuntime;
  config: SlackConfiguration;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch;
}) {
  const { pool, runtime, cipher } = options;
  const fetcher = options.fetcher ?? fetch;
  const config = slackConfigurationSchema.parse(options.config);
  async function requireManager(tx: AuthorizationTransaction, actor: HumanActor, allowCreate = false) {
    await currentMember(tx, actor);
    const local = z
      .object({ id: z.uuid() })
      .optional()
      .parse((await tx.client.query(`SELECT id FROM ${qualified(tx.schema, 'tf_slack_installations')}`)).rows[0]);
    if (!local ? !allowCreate : !(await canAccessSlackInstallation(tx, actor, local.id, 'manage')))
      throw new AccessDenied();
  }
  type Link = z.infer<typeof linkSchema>;
  async function installer(workspaceId: string) {
    return linkSchema
      .optional()
      .parse(
        (
          await pool.query(`SELECT * FROM app.slack_workspace_links WHERE workspace_id=$1 AND state='active'`, [
            workspaceId,
          ])
        ).rows[0],
      );
  }
  // Installations created before explicit managers keep their installer only when
  // the platform link proves this membership authorized the active credential.
  async function adoptInstaller(tx: AuthorizationTransaction, actor: HumanActor, link: Link | undefined) {
    if (!link || link.membership_id !== actor.membershipId || link.user_id !== actor.userId) return;
    await currentMember(tx, actor);
    const table = (name: string) => qualified(tx.schema, name);
    const eligible = await tx.client.query(
      `SELECT 1 FROM ${table('tf_slack_installations')} i WHERE i.id=$1 AND i.generation=$2 AND i.app_id=$3 AND i.team_id=$4 AND i.state<>'revoked'
      AND NOT EXISTS (SELECT 1 FROM ${table('tf_slack_installation_managers')} m WHERE m.installation_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM ${table('tf_audit_events')} e WHERE e.subject_id=i.id AND e.operation IN ('slack-installation.create','slack-installation.adopt'))`,
      [link.installation_id, link.generation, link.app_id, link.team_id],
    );
    if (!eligible.rowCount) return;
    const recommendations = await watchIntegrationRecommendations(tx, link.installation_id, () =>
      slackRecommendations(tx, link.installation_id),
    );
    const managerAdded = await tx.client.query(
      `INSERT INTO ${table('tf_slack_installation_managers')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING installation_id`,
      [link.installation_id, actor.membershipId],
    );
    const useAdded = await tx.client.query(
      `INSERT INTO ${table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING installation_id`,
      [link.installation_id, actor.membershipId],
    );
    if (!managerAdded.rowCount && !useAdded.rowCount) return;
    await tx.client.query(
      `INSERT INTO ${table('tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'slack-installation.adopt',$3)`,
      [randomUUID(), actor.membershipId, link.installation_id],
    );
    await recommendations();
  }
  async function manager(workspaceId: string, userId: string) {
    const link = await installer(workspaceId);
    return runtime.transaction(workspaceId, managementCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      await adoptInstaller(tx, actor, link);
      await requireManager(tx, actor, true);
      return actor;
    });
  }
  async function status(workspaceId: string, userId: string) {
    const evidence = await installer(workspaceId);
    const access = await runtime.transaction(workspaceId, managementCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      const member = await currentMember(tx, actor);
      await adoptInstaller(tx, actor, evidence);
      const local = z
        .object({
          id: z.uuid(),
          state: z.string(),
          generation: z.number().int(),
          scopes: z.array(z.string()),
          bot_credential: z.unknown(),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id,state,generation,scopes,bot_credential FROM ${qualified(tx.schema, 'tf_slack_installations')}`,
            )
          ).rows[0],
        );
      const canManage = local ? await canAccessSlackInstallation(tx, actor, local.id, 'manage') : true;
      if (local && !canManage && !(await canAccessSlackInstallation(tx, actor, local.id, 'use')))
        return { canManage: false, local: undefined, recoveryEventId: undefined, linked: false, hidden: true };
      const credential = storedCredentialSchema.safeParse(local?.bot_credential);
      if (
        local &&
        credential.success &&
        credential.data.rotation &&
        (credential.data.rotation.state === 'reconnect-required' ||
          (credential.data.rotation.state === 'ready' && credential.data.rotation.expiresAt <= Date.now()))
      )
        local.state = 'reconnect-required';
      const missingScopes = local ? config.scopeApproval.botScopes.filter(scope => !local.scopes.includes(scope)) : [];
      if (local?.state === 'active' && missingScopes.length) local.state = 'permissions-required';
      const recovery = z
        .object({ event_id: z.uuid(), credential: z.unknown() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT e.id AS event_id,p.credential FROM ${qualified(tx.schema, 'tf_slack_identities')} p JOIN ${qualified(tx.schema, 'tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation JOIN ${qualified(tx.schema, 'tf_slack_events')} e ON e.installation_id=p.installation_id AND e.generation=p.generation AND e.payload->>'user'=p.slack_user_id WHERE p.user_id=$1 AND p.membership_id=$2 AND p.state='authorized' AND e.disposition='held' ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
              [userId, member.id],
            )
          ).rows[0],
        );
      const userCredential = storedCredentialSchema.safeParse(recovery?.credential);
      const rotation = userCredential.success ? userCredential.data.rotation : undefined;
      const recoveryEventId =
        rotation &&
        (rotation.state === 'reconnect-required' || (rotation.state === 'ready' && rotation.expiresAt <= Date.now()))
          ? recovery?.event_id
          : undefined;
      const linked =
        (
          await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_identities')} p JOIN ${qualified(tx.schema, 'tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation WHERE p.user_id=$1 AND p.membership_id=$2 AND p.state='authorized' LIMIT 1`,
            [userId, member.id],
          )
        ).rowCount === 1;
      return { canManage, local, recoveryEventId, linked, hidden: false, missingScopes };
    });
    if (access.hidden)
      return { state: 'unavailable', teamId: null, canManage: false, linked: false, execution: 'disabled', scopes: [] };
    const link = linkSchema
      .extend({ expired: z.boolean() })
      .optional()
      .parse(
        (
          await pool.query(
            'SELECT *,expires_at<clock_timestamp() AS expired FROM app.slack_workspace_links WHERE workspace_id=$1',
            [workspaceId],
          )
        ).rows[0],
      );
    const matches = link?.state === 'active' && access.local?.generation === link.generation;
    if (link?.state === 'active' && access.local?.state === 'revoked')
      return {
        state: 'revoked',
        teamId: link.team_id,
        canManage: access.canManage,
        linked: false,
        execution: 'disabled',
        scopes: access.local.scopes,
      };
    const retryable =
      access.local &&
      (link?.state === 'failed' || link?.state === 'reserved' || (link?.state === 'authorizing' && link.expired));
    return {
      state: !link
        ? 'disconnected'
        : matches
          ? access.local?.state
          : retryable
            ? access.missingScopes?.length
              ? 'permissions-required'
              : 'reconnect-required'
            : link.state === 'active'
              ? 'reconnect-required'
              : link.state,
      teamId: link?.team_id ?? null,
      canManage: access.canManage,
      linked: matches && access.linked,
      execution: 'disabled',
      scopes: access.local?.scopes ?? [],
      ...(access.missingScopes?.length ? { missingScopes: access.missingScopes } : {}),
      ...(access.recoveryEventId ? { recoveryEventId: access.recoveryEventId } : {}),
    };
  }
  async function begin(workspaceId: string, userId: string, sessionId: string) {
    const actor = await manager(workspaceId, userId);
    const recovery = await runtime.transaction(workspaceId, managementCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      await requireManager(tx, actor, true);
      const local = z
        .object({
          generation: z.number().int(),
          state: z.string(),
          bot_credential: z.unknown(),
          scopes: z.array(z.string()),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT generation,state,bot_credential,scopes FROM ${qualified(tx.schema, 'tf_slack_installations')} FOR UPDATE`,
            )
          ).rows[0],
        );
      const stored = storedCredentialSchema.safeParse(local?.bot_credential);
      if (local?.state === 'revoked') {
        await pool.query(
          `UPDATE app.slack_workspace_links SET state='revoked',generation=GREATEST(generation,$2) WHERE workspace_id=$1 AND state='active'`,
          [workspaceId, local.generation],
        );
        return false;
      }
      const missingScopes = local && config.scopeApproval.botScopes.some(scope => !local.scopes.includes(scope));
      if (
        !local ||
        !['active', 'scope-missing'].includes(local.state) ||
        !stored.success ||
        !(
          missingScopes ||
          (stored.data.rotation &&
            (stored.data.rotation.state === 'reconnect-required' ||
              (stored.data.rotation.state === 'ready' && stored.data.rotation.expiresAt <= Date.now())))
        )
      )
        return false;
      const recommendations = await watchIntegrationRecommendations(tx, 'slack', () => slackRecommendations(tx));
      if (!missingScopes)
        await tx.client.query(`UPDATE ${qualified(tx.schema, 'tf_slack_installations')} SET bot_credential=$1`, [
          { ...stored.data, rotation: { state: 'reconnect-required' } },
        ]);
      await recommendations();
      return true;
    });
    const state = randomBytes(32).toString('base64url');
    const result = await pool.query(
      `INSERT INTO app.slack_workspace_links (workspace_id,installation_id,app_id,state,state_hash,session_id,user_id,membership_id,expires_at)
      VALUES ($1,$2,$3,'reserved',$4,$5,$6,$7,clock_timestamp()+interval '10 minutes')
      ON CONFLICT (workspace_id) DO UPDATE SET state='reserved',state_hash=EXCLUDED.state_hash,session_id=EXCLUDED.session_id,user_id=EXCLUDED.user_id,membership_id=EXCLUDED.membership_id,expires_at=EXCLUDED.expires_at,generation=app.slack_workspace_links.generation+CASE WHEN $8 THEN 0 ELSE 1 END
      WHERE app.slack_workspace_links.state IN ('failed','revoked') OR ($8 AND app.slack_workspace_links.state IN ('active','reserved')) OR (app.slack_workspace_links.state IN ('reserved','authorizing') AND app.slack_workspace_links.expires_at<clock_timestamp())
      RETURNING installation_id`,
      [workspaceId, randomUUID(), config.appId, hash(state), sessionId, userId, actor.membershipId, recovery],
    );
    if (!result.rowCount) throw new Error('slack-installation-conflict');
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopeApproval.botScopes.join(','),
      redirect_uri: config.redirectUri,
      state,
    }).toString();
    return { url: url.href };
  }
  async function complete(code: string, state: string, sessionId: string, userId: string) {
    const link = linkSchema
      .optional()
      .parse(
        (
          await pool.query(
            `SELECT * FROM app.slack_workspace_links WHERE state_hash=$1 AND state='reserved' AND expires_at>clock_timestamp()`,
            [hash(state)],
          )
        ).rows[0],
      );
    if (!link || link.session_id !== sessionId || link.user_id !== userId || link.app_id !== config.appId)
      throw new AccessDenied();
    const actor = await manager(link.workspace_id, userId);
    if (actor.membershipId !== link.membership_id) throw new AccessDenied();
    const claimed = await pool.query(
      `UPDATE app.slack_workspace_links SET state='authorizing' WHERE workspace_id=$1 AND state_hash=$2 AND state='reserved' AND expires_at>clock_timestamp() RETURNING workspace_id`,
      [link.workspace_id, hash(state)],
    );
    if (!claimed.rowCount) throw new Error('slack-callback-consumed');
    try {
      const oauth = await exchangeCode(config, code, options.fetcher ?? fetch);
      const scopes = [...new Set(oauth.scope.split(',').filter(Boolean))];
      const missing = config.scopeApproval.botScopes.some(scope => !scopes.includes(scope));
      const reserved = await pool.query(
        `UPDATE app.slack_workspace_links SET team_id=$2 WHERE workspace_id=$1 AND installation_id=$3 AND generation=$4 AND state='authorizing' AND (team_id IS NULL OR team_id=$2) RETURNING workspace_id`,
        [link.workspace_id, oauth.team.id, link.installation_id, link.generation],
      );
      if (!reserved.rowCount) throw new Error('slack-installation-conflict');
      await runtime.transaction(link.workspace_id, managementCompatibility, async tx => {
        await lockAuthorization(tx, 'write');
        await requireManager(tx, actor, true);
        const recommendations = await watchIntegrationRecommendations(tx, link.installation_id, () =>
          slackRecommendations(tx, link.installation_id),
        );
        const creating = !(
          await tx.client.query(`SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_installations')} WHERE id=$1`, [
            link.installation_id,
          ])
        ).rowCount;
        const credential = encryptSlackToken(
          cipher,
          {
            workspaceId: link.workspace_id,
            installationId: link.installation_id,
            generation: link.generation,
            kind: 'bot',
          },
          oauth.access_token,
          oauth,
        );
        const saved = await tx.client.query(
          `INSERT INTO ${qualified(tx.schema, 'tf_slack_installations')} AS installation (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after)
          VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,ceil(extract(epoch FROM clock_timestamp()))) ON CONFLICT (id) DO UPDATE SET bot_user_id=EXCLUDED.bot_user_id,generation=EXCLUDED.generation,state='reserved',scopes=EXCLUDED.scopes,bot_credential=EXCLUDED.bot_credential,accepts_events_after=CASE WHEN installation.generation=EXCLUDED.generation THEN installation.accepts_events_after ELSE EXCLUDED.accepts_events_after END
          WHERE installation.generation<EXCLUDED.generation OR (installation.generation=EXCLUDED.generation AND installation.state IN ('active','scope-missing') AND installation.team_id=EXCLUDED.team_id AND installation.bot_user_id=EXCLUDED.bot_user_id AND (installation.bot_credential->'rotation'->>'state'='reconnect-required' OR NOT installation.scopes @> $8::text[])) RETURNING id`,
          [
            link.installation_id,
            config.appId,
            oauth.team.id,
            oauth.bot_user_id,
            link.generation,
            scopes,
            credential,
            config.scopeApproval.botScopes,
          ],
        );
        if (!saved.rowCount) throw new Error('slack-installation-conflict');
        if (creating) {
          await tx.client.query(
            `INSERT INTO ${qualified(tx.schema, 'tf_slack_installation_managers')} (installation_id,membership_id) VALUES ($1,$2)`,
            [link.installation_id, actor.membershipId],
          );
          await tx.client.query(
            `INSERT INTO ${qualified(tx.schema, 'tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2)`,
            [link.installation_id, actor.membershipId],
          );
          await tx.client.query(
            `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'slack-installation.create',$3)`,
            [randomUUID(), actor.membershipId, link.installation_id],
          );
        }
        await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_slack_action_effects')} e SET state=CASE WHEN e.state='sending' THEN 'unknown' ELSE 'stale' END FROM ${qualified(tx.schema, 'tf_slack_actions')} a WHERE a.id=e.action_id AND a.installation_id=$1 AND e.state IN ('pending','retry','reauthorization-required','sending')`,
          [link.installation_id],
        );
        await recommendations();
      });
      await runtime.transaction(link.workspace_id, managementCompatibility, async tx => {
        await lockAuthorization(tx);
        await requireManager(tx, actor);
        const recommendations = await watchIntegrationRecommendations(tx, link.installation_id, () =>
          slackRecommendations(tx, link.installation_id),
        );
        const local = await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_slack_installations')} SET state=$3 WHERE id=$1 AND generation=$2 AND state='reserved' RETURNING id`,
          [link.installation_id, link.generation, missing ? 'scope-missing' : 'active'],
        );
        if (!local.rowCount) throw new Error('slack-installation-conflict');
        const activated = await pool.query(
          `UPDATE app.slack_workspace_links SET state='active' WHERE workspace_id=$1 AND generation=$2 AND state='authorizing' RETURNING workspace_id`,
          [link.workspace_id, link.generation],
        );
        if (!activated.rowCount) throw new Error('slack-installation-conflict');
        await recommendations();
      });
      return {
        workspaceId: link.workspace_id,
        teamId: oauth.team.id,
        state: missing ? 'scope-missing' : 'active',
        execution: 'disabled',
      };
    } catch {
      await pool.query(
        `UPDATE app.slack_workspace_links SET state='failed' WHERE workspace_id=$1 AND generation=$2 AND state='authorizing'`,
        [link.workspace_id, link.generation],
      );
      throw new Error('slack-installation-unavailable');
    }
  }
  async function disconnect(workspaceId: string, userId: string) {
    await runtime.transaction(workspaceId, managementCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, userId);
      await requireManager(tx, actor);
      const recommendations = await watchIntegrationRecommendations(tx, 'slack', () => slackRecommendations(tx));
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_installations')} SET state='revoked',generation=generation+1,bot_credential=NULL WHERE state<>'revoked'`,
      );
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_identities')} SET state='revoked',credential=NULL`,
      );
      await tx.client.query(`UPDATE ${qualified(tx.schema, 'tf_slack_continuations')} SET state='cancelled'`);
      await pool.query(
        `UPDATE app.slack_workspace_links SET state='revoked',generation=generation+1 WHERE workspace_id=$1 AND state<>'revoked'`,
        [workspaceId],
      );
      await recommendations();
    });
    return { state: 'revoked', execution: 'disabled', providerRevocation: 'manual-required' };
  }
  async function route(appId: string, teamId: string) {
    const link = linkSchema
      .optional()
      .parse(
        (
          await pool.query(
            `SELECT * FROM app.slack_workspace_links WHERE app_id=$1 AND team_id=$2 AND state='active'`,
            [appId, teamId],
          )
        ).rows[0],
      );
    return link
      ? { workspaceId: link.workspace_id, installationId: link.installation_id, generation: link.generation }
      : null;
  }
  async function grants(workspaceId: string, userId: string, input?: unknown) {
    return runtime.transaction(workspaceId, managementCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, userId);
      await requireManager(tx, actor);
      const { id } = z
        .object({ id: z.uuid() })
        .parse((await tx.client.query(`SELECT id FROM ${qualified(tx.schema, 'tf_slack_installations')}`)).rows[0]);
      const recipients = z.strictObject({
        memberIds: z.array(z.uuid()).max(1000),
        teamIds: z.array(z.uuid()).max(1000),
      });
      const schema = z.strictObject({ use: recipients, managers: recipients, expectedVersion: z.string() });
      const read = async () => {
        const result = {
          use: { memberIds: [] as string[], teamIds: [] as string[] },
          managers: { memberIds: [] as string[], teamIds: [] as string[] },
        };
        for (const [kind, name] of [
          ['use', 'tf_slack_installation_grants'],
          ['managers', 'tf_slack_installation_managers'],
        ] as const) {
          const rows = z
            .array(z.object({ membership_id: z.uuid().nullable(), team_id: z.uuid().nullable() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT membership_id,team_id FROM ${qualified(tx.schema, name)} WHERE installation_id=$1 ORDER BY membership_id,team_id`,
                  [id],
                )
              ).rows,
            );
          result[kind] = {
            memberIds: rows.flatMap(row => (row.membership_id ? [row.membership_id] : [])),
            teamIds: rows.flatMap(row => (row.team_id ? [row.team_id] : [])),
          };
        }
        return { ...result, expectedVersion: hash(JSON.stringify(result)) };
      };
      if (input === undefined) return read();
      const value = schema.parse(input);
      const current = await read();
      if (current.expectedVersion !== value.expectedVersion) throw new Error('slack-grants-conflict');
      const recommendations = await watchIntegrationRecommendations(tx, id, () => slackRecommendations(tx, id));
      const retained = [...current.use.teamIds, ...current.managers.teamIds];
      for (const group of [value.use, value.managers]) {
        for (const memberId of group.memberIds)
          if (
            !(
              await tx.client.query(
                `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
                [memberId],
              )
            ).rowCount
          )
            throw new AccessDenied();
        for (const teamId of group.teamIds)
          if (
            !retained.includes(teamId) &&
            !(
              await tx.client.query(
                `SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`,
                [actor.membershipId, teamId],
              )
            ).rowCount
          )
            throw new AccessDenied();
      }
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m WHERE removed_at IS NULL AND (id=ANY($1::uuid[]) OR EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=ANY($2::uuid[]))) LIMIT 1`,
            [value.managers.memberIds, value.managers.teamIds],
          )
        ).rowCount
      )
        throw new AccessDenied();
      for (const [kind, name] of [
        ['use', 'tf_slack_installation_grants'],
        ['managers', 'tf_slack_installation_managers'],
      ] as const) {
        await tx.client.query(`DELETE FROM ${qualified(tx.schema, name)} WHERE installation_id=$1`, [id]);
        for (const memberId of new Set(value[kind].memberIds))
          await tx.client.query(
            `INSERT INTO ${qualified(tx.schema, name)} (installation_id,membership_id) VALUES ($1,$2)`,
            [id, memberId],
          );
        for (const teamId of new Set(value[kind].teamIds))
          await tx.client.query(`INSERT INTO ${qualified(tx.schema, name)} (installation_id,team_id) VALUES ($1,$2)`, [
            id,
            teamId,
          ]);
      }
      await tx.client.query(
        `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'slack-installation.grants',$3)`,
        [randomUUID(), actor.membershipId, id],
      );
      await recommendations();
      return read();
    });
  }
  // Lists conversations the bot user belongs to. Only scopes granted at install decide which kinds are read.
  async function channels(workspaceId: string, userId: string) {
    const link = await installer(workspaceId);
    const local = await runtime.transaction(workspaceId, managementCompatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      const row = z
        .object({
          id: z.uuid(),
          generation: z.number().int(),
          scopes: z.array(z.string()),
          bot_credential: z.unknown(),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id,generation,scopes,bot_credential FROM ${qualified(tx.schema, 'tf_slack_installations')} WHERE state='active' AND app_id=$1 AND bot_credential IS NOT NULL`,
              [config.appId],
            )
          ).rows[0],
        );
      if (!row || !link || link.installation_id !== row.id || link.generation !== row.generation)
        throw new AccessDenied();
      // The bot credential is shared, so listing follows the installation grants that status uses; workspace role grants nothing.
      if (
        !(await canAccessSlackInstallation(tx, actor, row.id, 'manage')) &&
        !(await canAccessSlackInstallation(tx, actor, row.id, 'use'))
      )
        throw new AccessDenied();
      return row;
    });
    const types = [
      ...(local.scopes.includes('channels:read') ? ['public_channel'] : []),
      ...(local.scopes.includes('groups:read') ? ['private_channel'] : []),
    ];
    const missingScopes = ['channels:read', 'groups:read'].filter(scope => !local.scopes.includes(scope));
    if (!types.length) return { channels: [], complete: true, missingScopes };
    let token: string;
    try {
      token = cipher.decrypt(
        { workspaceId, installationId: local.id, generation: local.generation, kind: 'bot' },
        local.bot_credential,
      );
    } catch {
      throw new SlackApiError('provider-auth-rejected');
    }
    const pageSchema = z.object({
      channels: z.array(
        z.object({
          id: slackId,
          name: z.string().max(256).optional(),
          is_private: z.boolean().optional(),
          is_archived: z.boolean().optional(),
        }),
      ),
      response_metadata: z.object({ next_cursor: z.string().max(2048).optional() }).optional(),
    });
    const found = new Map<string, { id: string; name: string; private: boolean }>();
    let cursor = '';
    let pages = 0;
    do {
      const page = pageSchema.parse(
        await callSlackApi({
          token,
          method: 'users.conversations',
          fetcher,
          params: { types: types.join(','), exclude_archived: true, limit: 200, cursor: cursor || undefined },
        }),
      );
      for (const channel of page.channels)
        if (channel.name && !channel.is_archived)
          found.set(channel.id, { id: channel.id, name: channel.name, private: channel.is_private === true });
      cursor = page.response_metadata?.next_cursor ?? '';
      pages++;
    } while (cursor && pages < channelPageLimit);
    return {
      channels: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
      complete: !cursor,
      missingScopes,
    };
  }
  return { status, begin, complete, disconnect, route, grants, channels };
}
