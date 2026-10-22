import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { currentMember, lockAuthorization } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { slackId, type SlackConfiguration } from './contracts.ts';
import {
  encryptSlackToken,
  storedCredentialSchema,
  type SlackCredentialBinding,
  type slackCredentialCipher,
} from './credentials.ts';
import { slackCompatibility, type SlackRuntime } from './installations.ts';
import { readSlackJson, slackUserTokenProof } from './user-token.ts';
import { watchIntegrationRecommendations } from '@tulipfarm/integrations/authorization';
import { slackRecommendations } from './recommendations.ts';

const rowSchema = z.object({
  id: z.uuid(),
  installation_id: z.uuid(),
  generation: z.number().int(),
  team_id: slackId,
  slack_user_id: slackId,
  membership_id: z.uuid().nullable(),
  user_id: z.string().nullable(),
  credential: storedCredentialSchema,
  scopes: z.array(z.string()),
  kind: z.enum(['bot', 'user']),
});
const userReplySchema = z.object({
  ok: z.literal(true),
  access_token: z.string().max(4096),
  refresh_token: z
    .string()
    .regex(/^xoxe-[A-Za-z0-9-]+$/)
    .max(4096),
  expires_in: z.number().int().positive().max(86400),
});
const botReplySchema = userReplySchema.extend({
  token_type: z.literal('bot'),
  team: z.object({ id: slackId }),
  app_id: slackId.optional(),
  bot_user_id: slackId,
  scope: z.string(),
});

export async function slackCredentialsReady(
  runtime: SlackRuntime,
  work: { workspaceId: string; eventId: string },
  botOnly = false,
) {
  return runtime.transaction(work.workspaceId, slackCompatibility, async tx => {
    const table = (name: string) => qualified(tx.schema, name);
    const row = z
      .object({ bot: z.unknown(), user: z.unknown() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT i.bot_credential AS bot,p.credential AS "user" FROM ${table('tf_slack_events')} e JOIN ${table('tf_slack_installations')} i ON i.id=e.installation_id AND i.generation=e.generation LEFT JOIN ${table('tf_slack_identities')} p ON p.installation_id=e.installation_id AND p.generation=e.generation AND p.slack_user_id=e.payload->>'user' WHERE e.id=$1`,
            [work.eventId],
          )
        ).rows[0],
      );
    if (!row) return true;
    return (botOnly ? [row.bot] : [row.bot, row.user]).every(value => {
      const parsed = storedCredentialSchema.safeParse(value);
      if (!parsed.success || !parsed.data.rotation) return true;
      return parsed.data.rotation.state === 'ready' && parsed.data.rotation.expiresAt > Date.now() + 30000;
    });
  });
}

export function createSlackRecovery(options: {
  runtime: SlackRuntime;
  config: SlackConfiguration;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch;
}) {
  const { runtime, config, cipher } = options;
  async function refresh(workspaceId: string) {
    const candidates = await runtime.transaction(workspaceId, slackCompatibility, async tx => {
      const table = (name: string) => qualified(tx.schema, name);
      return z.array(z.object({ id: z.uuid(), kind: z.enum(['bot', 'user']) })).parse(
        (
          await tx.client.query(
            `
        SELECT id,'bot' AS kind FROM ${table('tf_slack_installations')} WHERE app_id=$1 AND state='active' AND (bot_credential->'rotation'->>'state'='ready' AND (bot_credential->'rotation'->>'expiresAt')::numeric<=$2 OR bot_credential->'rotation'->>'state'='refreshing' AND (bot_credential->'rotation'->>'deadline')::numeric<=$3)
        UNION ALL SELECT p.id,'user' AS kind FROM ${table('tf_slack_identities')} p JOIN ${table('tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation WHERE i.app_id=$1 AND i.state='active' AND p.state='authorized' AND (p.credential->'rotation'->>'state'='ready' AND (p.credential->'rotation'->>'expiresAt')::numeric<=$2 OR p.credential->'rotation'->>'state'='refreshing' AND (p.credential->'rotation'->>'deadline')::numeric<=$3) LIMIT 100`,
            [config.appId, Date.now() + 300000, Date.now()],
          )
        ).rows,
      );
    });
    const outcomes = [];
    for (const candidate of candidates) {
      const claimed = await runtime.transaction(workspaceId, slackCompatibility, async tx => {
        await lockAuthorization(tx);
        const table = (name: string) => qualified(tx.schema, name);
        const raw =
          candidate.kind === 'bot'
            ? await tx.client.query(
                `SELECT id,id AS installation_id,generation,team_id,bot_user_id AS slack_user_id,NULL AS membership_id,NULL AS user_id,bot_credential AS credential,scopes,'bot' AS kind FROM ${table('tf_slack_installations')} WHERE id=$1 AND app_id=$2 AND state='active' FOR UPDATE`,
                [candidate.id, config.appId],
              )
            : await tx.client.query(
                `SELECT p.id,p.installation_id,p.generation,i.team_id,p.slack_user_id,p.membership_id,p.user_id,p.credential,p.scopes,'user' AS kind FROM ${table('tf_slack_identities')} p JOIN ${table('tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation WHERE p.id=$1 AND i.app_id=$2 AND i.state='active' AND p.state='authorized' AND NOT EXISTS(SELECT 1 FROM ${table('tf_slack_user_revocations')} v WHERE v.installation_id=p.installation_id AND v.generation=p.generation AND v.slack_user_id=p.slack_user_id) FOR UPDATE OF i,p`,
                [candidate.id, config.appId],
              );
        if (!raw.rowCount) return null;
        const row = rowSchema.parse(raw.rows[0]);
        if (row.kind === 'user') {
          if (!row.user_id || !row.membership_id) return null;
          try {
            await currentMember(tx, { kind: 'human', userId: row.user_id, membershipId: row.membership_id });
          } catch {
            return null;
          }
        }
        const rotation = row.credential.rotation;
        if (!rotation || rotation.state === 'reconnect-required') return null;
        const relation = table(row.kind === 'bot' ? 'tf_slack_installations' : 'tf_slack_identities');
        const column = row.kind === 'bot' ? 'bot_credential' : 'credential';
        if (rotation.state === 'refreshing') {
          if (rotation.deadline <= Date.now()) {
            const recommendations = await watchIntegrationRecommendations(tx, row.installation_id, () =>
              slackRecommendations(tx, row.installation_id),
            );
            await tx.client.query(`UPDATE ${relation} SET ${column}=$2 WHERE id=$1`, [
              row.id,
              { ...row.credential, rotation: { state: 'reconnect-required' } },
            ]);
            await recommendations();
          }
          return null;
        }
        if (rotation.expiresAt > Date.now() + 300000) return null;
        const binding: SlackCredentialBinding =
          row.kind === 'bot'
            ? { workspaceId, installationId: row.installation_id, generation: row.generation, kind: 'bot' }
            : {
                workspaceId,
                installationId: row.installation_id,
                generation: row.generation,
                kind: 'user',
                identityId: row.id,
                membershipId: z.uuid().parse(row.membership_id),
                slackUserId: row.slack_user_id,
              };
        const token = cipher.decrypt(binding, rotation.refresh);
        const claim = {
          ...row.credential,
          rotation: { state: 'refreshing' as const, attempt: randomUUID(), deadline: Date.now() + 30000 },
        };
        await tx.client.query(`UPDATE ${relation} SET ${column}=$2 WHERE id=$1`, [row.id, claim]);
        return { row, binding, token, claim };
      });
      if (!claimed) continue;
      const { row, binding, claim } = claimed;
      let credential: z.infer<typeof storedCredentialSchema> = { ...claim, rotation: { state: 'reconnect-required' } };
      try {
        const response = await (options.fetcher ?? fetch)(
          `https://slack.com/api/${row.kind === 'bot' ? 'oauth.v2.access' : 'oauth.v2.user.access'}`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
            headers: {
              Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
            },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: claimed.token }),
          },
        );
        const reply = await readSlackJson(response);
        let proof: { access_token: string; refresh_token: string; expires_in: number },
          owner: { teamId: string; userId: string; scopes: string[] };
        if (row.kind === 'bot') {
          const bot = botReplySchema.parse(reply);
          if (bot.app_id && bot.app_id !== config.appId) throw new Error('slack-refresh-mismatch');
          proof = bot;
          owner = {
            teamId: bot.team.id,
            userId: bot.bot_user_id,
            scopes: [...new Set(bot.scope.split(/[ ,]+/).filter(Boolean))],
          };
        } else {
          proof = userReplySchema.parse(reply);
          owner = await slackUserTokenProof(options.fetcher ?? fetch, proof.access_token);
        }
        if (
          owner.teamId !== row.team_id ||
          owner.userId !== row.slack_user_id ||
          owner.scopes.length !== row.scopes.length ||
          row.scopes.some(scope => !owner.scopes.includes(scope)) ||
          !(row.kind === 'bot' ? /^xoxe\.xoxb-[A-Za-z0-9-]+$/ : /^xoxe\.xoxp-[A-Za-z0-9-]+$/).test(proof.access_token)
        )
          throw new Error('slack-refresh-mismatch');
        credential = encryptSlackToken(cipher, binding, proof.access_token, proof);
      } catch {
        /* An uncertain exchange consumes this local refresh attempt permanently. */
      }
      const saved = await runtime.transaction(workspaceId, slackCompatibility, async tx => {
        await lockAuthorization(tx);
        const table = (name: string) => qualified(tx.schema, name);
        const installation = await tx.client.query(
          `SELECT id FROM ${table('tf_slack_installations')} WHERE id=$1 AND generation=$2 AND state='active' FOR UPDATE`,
          [row.installation_id, row.generation],
        );
        if (!installation.rowCount) return false;
        if (claim.rotation.deadline <= Date.now()) credential = { ...claim, rotation: { state: 'reconnect-required' } };
        if (row.kind === 'user') {
          try {
            await currentMember(tx, {
              kind: 'human',
              userId: z.string().parse(row.user_id),
              membershipId: z.uuid().parse(row.membership_id),
            });
          } catch {
            return false;
          }
        }
        const relation = table(row.kind === 'bot' ? 'tf_slack_installations' : 'tf_slack_identities');
        const column = row.kind === 'bot' ? 'bot_credential' : 'credential';
        const recommendations = await watchIntegrationRecommendations(tx, row.installation_id, () =>
          slackRecommendations(tx, row.installation_id),
        );
        const saved = Boolean(
          (
            await tx.client.query(
              `UPDATE ${relation} SET ${column}=$2 WHERE id=$1 AND generation=$3 AND ${column}=$4::jsonb AND state=$5`,
              [row.id, credential, row.generation, claim, row.kind === 'bot' ? 'active' : 'authorized'],
            )
          ).rowCount,
        );
        await recommendations();
        return saved;
      });
      outcomes.push({ kind: row.kind, id: row.id, state: saved ? credential.rotation?.state : 'fenced' });
    }
    return outcomes;
  }
  return { refresh };
}
