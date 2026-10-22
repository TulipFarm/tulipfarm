import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockAuthorization } from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { renderSlackAnswer } from '@tulipfarm/slack-presentation';
import { messageSchema, slackId } from './contracts.ts';
import type { SlackRuntime } from './installations.ts';
import type { slackCredentialCipher } from './credentials.ts';
import { slackCredentialsReady } from './recovery.ts';

export const slackPromptWorkSchema = z.strictObject({ workspaceId: z.uuid(), eventId: z.uuid() });
export type SlackPromptWork = z.infer<typeof slackPromptWorkSchema>;
const compatibility = commonCompatibility;
const rowSchema = z.object({
  event_id: z.uuid(),
  installation_id: z.uuid(),
  generation: z.number().int(),
  slack_user_id: slackId,
  state: z.enum(['pending', 'sending', 'retry', 'sent', 'unknown', 'blocked', 'linked']),
  due: z.boolean(),
  attempt_id: z.uuid().nullable(),
  payload: z.unknown(),
});
type Transaction = Parameters<Parameters<SlackRuntime['transaction']>[2]>[0];
type Outcome =
  | { kind: 'sent'; channel: string; ts: string }
  | { kind: 'retry'; seconds: number }
  | { kind: 'unknown' }
  | { kind: 'blocked' };

export function createSlackLinkPrompts(options: {
  runtime: SlackRuntime;
  appId: string;
  webOrigin: string;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch;
}) {
  const { runtime, cipher } = options;
  const appId = slackId.parse(options.appId);
  const web = new URL(options.webOrigin);
  if (web.protocol !== 'https:' || web.username || web.password || web.pathname !== '/' || web.search || web.hash)
    throw new Error('slack-web-origin-invalid');
  async function transaction<T>(workspaceId: string, operation: (tx: Transaction) => Promise<T>) {
    return runtime.transaction(z.uuid().parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx);
    });
  }
  async function discover(workspaceId: string): Promise<SlackPromptWork[]> {
    return transaction(workspaceId, async tx => {
      const table = (name: string) => qualified(tx.schema, name);
      await tx.client.query(
        `INSERT INTO ${table('tf_slack_link_prompts')} (event_id,installation_id,generation,slack_user_id)
        SELECT e.id,e.installation_id,e.generation,e.payload->>'user'
        FROM ${table('tf_slack_events')} e JOIN ${table('tf_slack_installations')} i ON i.id=e.installation_id AND i.generation=e.generation
        WHERE e.disposition='held' AND (e.payload->>'channel' LIKE 'D%'
          OR (e.payload->>'channel' ~ '^[CG]' AND (e.payload->>'type'='app_mention' OR strpos(e.payload->>'text','<@' || i.bot_user_id || '>')>0))
          OR EXISTS (SELECT 1 FROM ${table('tf_slack_channel_invocations')} c WHERE c.event_id=e.id)) AND i.state='active' AND i.app_id=$1
        AND NOT EXISTS (SELECT 1 FROM ${table('tf_slack_link_prompts')} p WHERE p.event_id=e.id)
        ORDER BY e.created_at,e.id LIMIT 50 ON CONFLICT DO NOTHING`,
        [appId],
      );
      const rows = z
        .array(z.object({ event_id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT event_id FROM ${table('tf_slack_link_prompts')} WHERE state IN ('pending','retry','sending') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,event_id LIMIT 50`,
            )
          ).rows,
        );
      return rows.map(row => ({ workspaceId, eventId: row.event_id }));
    });
  }
  async function load(tx: Transaction, eventId: string) {
    return rowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT p.*,p.next_attempt_at<=clock_timestamp() AS due,e.payload FROM ${qualified(tx.schema, 'tf_slack_link_prompts')} p JOIN ${qualified(tx.schema, 'tf_slack_events')} e ON e.id=p.event_id WHERE p.event_id=$1 FOR UPDATE OF p`,
            [eventId],
          )
        ).rows[0],
      );
  }
  async function authorization(tx: Transaction, row: z.infer<typeof rowSchema>) {
    const table = (name: string) => qualified(tx.schema, name);
    const installation = z
      .object({ bot_credential: z.unknown(), bot_user_id: slackId, scopes: z.array(z.string()) })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT bot_credential,bot_user_id,scopes FROM ${table('tf_slack_installations')} WHERE id=$1 AND generation=$2 AND state='active' AND app_id=$3 FOR UPDATE`,
            [row.installation_id, row.generation, appId],
          )
        ).rows[0],
      );
    if (!installation || !installation.scopes.includes('chat:write') || row.slack_user_id === installation.bot_user_id)
      return { kind: 'blocked' as const };
    const identities = await tx.client.query(
      `SELECT 1 FROM ${table('tf_slack_identities')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3 AND state='authorized' AND credential IS NOT NULL AND COALESCE(credential->'rotation'->>'state','ready')<>'reconnect-required'`,
      [row.installation_id, row.generation, row.slack_user_id],
    );
    const revoked = await tx.client.query(
      `SELECT 1 FROM ${table('tf_slack_user_revocations')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3`,
      [row.installation_id, row.generation, row.slack_user_id],
    );
    if (revoked.rowCount) return { kind: 'blocked' as const };
    if (identities.rowCount) return { kind: 'linked' as const };
    return { kind: 'allowed' as const, credential: installation.bot_credential, botUserId: installation.bot_user_id };
  }
  async function post(
    token: string,
    source: z.infer<typeof messageSchema>,
    eventId: string,
    workspaceId: string,
  ): Promise<Outcome> {
    const channel = source.channel;
    const ephemeral = !channel.startsWith('D');
    const method = ephemeral ? 'chat.postEphemeral' : 'chat.postMessage';
    const url = new URL('/slack/link', web);
    url.search = new URLSearchParams({ workspaceId, eventId }).toString();
    const message = renderSlackAnswer(
      `[Link your TulipFarm account](${url.href}) to continue your request. You must already belong to this TulipFarm workspace.`,
    );
    try {
      const response = await (options.fetcher ?? fetch)(`https://slack.com/api/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          ...(ephemeral ? { user: source.user, ...(source.thread_ts ? { thread_ts: source.thread_ts } : {}) } : {}),
          text: `${message.text} ${url.href}`,
          blocks: message.blocks,
          mrkdwn: false,
          parse: 'none',
          link_names: false,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400
          ? { kind: 'retry', seconds }
          : { kind: 'unknown' };
      }
      if (!response.ok) return { kind: 'unknown' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) return { kind: 'unknown' };
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 131072) return { kind: 'unknown' };
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const timestamp = z.string().regex(/^\d{1,16}\.\d{6}$/);
      const result = z
        .object({
          ok: z.boolean(),
          channel: slackId.optional(),
          ts: timestamp.optional(),
          message_ts: timestamp.optional(),
          error: z.string().optional(),
        })
        .parse(JSON.parse(text));
      if (result.ok && ephemeral && result.message_ts) return { kind: 'sent', channel, ts: result.message_ts };
      if (result.ok && !ephemeral && result.channel === channel && result.ts)
        return { kind: 'sent', channel, ts: result.ts };
      if (
        !result.ok &&
        [
          'channel_not_found',
          'not_in_channel',
          'user_not_in_channel',
          'missing_scope',
          'invalid_auth',
          'token_revoked',
          'token_expired',
          'account_inactive',
          'messages_tab_disabled',
          'restricted_action',
          'app_access_restricted',
        ].includes(result.error ?? '')
      )
        return { kind: 'blocked' };
      return { kind: 'unknown' };
    } catch {
      return { kind: 'unknown' };
    }
  }
  async function process(value: unknown): Promise<'idle' | 'sent' | 'retry' | 'unknown' | 'blocked' | 'linked'> {
    const work = slackPromptWorkSchema.parse(value);
    if (!(await slackCredentialsReady(runtime, work, true))) return 'idle';
    const attemptId = randomUUID();
    const claim = await transaction(work.workspaceId, async tx => {
      const row = await load(tx, work.eventId);
      if (!row || !row.due || !['pending', 'retry', 'sending'].includes(row.state)) return false;
      if (row.state === 'sending') {
        await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_slack_link_prompts')} SET state='unknown' WHERE event_id=$1`,
          [work.eventId],
        );
        return false;
      }
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_link_prompts')} SET state='sending',attempt_id=$2,next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE event_id=$1`,
        [work.eventId, attemptId],
      );
      return true;
    });
    if (!claim) return 'idle';
    return transaction(work.workspaceId, async tx => {
      const row = await load(tx, work.eventId);
      if (!row || row.state !== 'sending' || row.attempt_id !== attemptId) return 'idle';
      const access = await authorization(tx, row);
      let outcome: Outcome | { kind: 'linked' } = access.kind === 'allowed' ? { kind: 'blocked' } : access;
      if (access.kind === 'allowed') {
        const message = messageSchema.safeParse(row.payload);
        if (
          message.success &&
          !message.data.bot_id &&
          !message.data.subtype &&
          message.data.user === row.slack_user_id
        ) {
          const token = cipher.decrypt(
            {
              workspaceId: work.workspaceId,
              installationId: row.installation_id,
              generation: row.generation,
              kind: 'bot',
            },
            access.credential,
          );
          const direct = message.data.channel.startsWith('D');
          const mention =
            /^[CG]/.test(message.data.channel) &&
            (message.data.type === 'app_mention' || message.data.text.includes(`<@${access.botUserId}>`));
          const invoked =
            !direct &&
            !mention &&
            (
              await tx.client.query(
                `SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_channel_invocations')} WHERE event_id=$1`,
                [work.eventId],
              )
            ).rowCount;
          if (direct || mention || invoked) outcome = await post(token, message.data, work.eventId, work.workspaceId);
        }
      }
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_link_prompts')} SET state=$2,next_attempt_at=clock_timestamp()+$3*interval '1 second',delivered_channel=$4,delivered_ts=$5 WHERE event_id=$1`,
        [
          work.eventId,
          outcome.kind,
          outcome.kind === 'retry' ? outcome.seconds : 0,
          outcome.kind === 'sent' ? outcome.channel : null,
          outcome.kind === 'sent' ? outcome.ts : null,
        ],
      );
      return outcome.kind;
    });
  }
  return { discover, process };
}
