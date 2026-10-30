import { z } from 'zod';
import { renderSlackAnswer, parseSlackSurface, type SlackMessage } from '@tulipfarm/slack-presentation';
import { slackId } from './contracts.ts';

export type BotMessageOutcome =
  | { kind: 'sent'; channel: string; ts: string; text: string }
  | { kind: 'retry'; seconds: number }
  | { kind: 'unknown' }
  | { kind: 'blocked' };

export async function botChannelInfo(token: string, channel: string, fetcher: typeof fetch = fetch) {
  const url = new URL('https://slack.com/api/conversations.info');
  url.searchParams.set('channel', slackId.parse(channel));
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok || !response.body) throw new Error('slack-channel-unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 32768) throw new Error('slack-channel-unavailable');
    chunks.push(chunk);
  }
  const result = z
    .object({
      ok: z.literal(true),
      channel: z.object({ id: slackId, is_archived: z.boolean(), is_member: z.boolean() }),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (result.channel.id !== channel) throw new Error('slack-channel-unavailable');
  return result.channel;
}

export async function openBotDirectMessage(token: string, user: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher('https://slack.com/api/conversations.open', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: slackId.parse(user), return_im: true }),
  });
  if (!response.ok || !response.body) throw new Error('slack-dm-unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 32768) throw new Error('slack-dm-unavailable');
    chunks.push(chunk);
  }
  const result = z
    .object({
      ok: z.literal(true),
      channel: z.object({ id: slackId.refine(id => id.startsWith('D')), is_im: z.literal(true), user: slackId }),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (result.channel.user !== user) throw new Error('slack-dm-unavailable');
  return result.channel.id;
}

const loadingMessages = [
  'Reviewing the request...',
  'Checking the relevant context...',
  'Working through the details...',
  'Preparing a useful answer...',
];

export async function setBotThreadStatus(input: {
  token: string;
  channel: string;
  threadTs: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  try {
    await (input.fetcher ?? fetch)('https://slack.com/api/assistant.threads.setStatus', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: slackId.parse(input.channel),
        thread_ts: input.threadTs,
        status: 'is working on your request...',
        loading_messages: loadingMessages,
      }),
    });
  } catch {
    /* The reply remains deliverable when Slack cannot present a transient status. */
  }
}

export async function postBotMessage(input: {
  token: string;
  channel: string;
  rootTs?: string | undefined;
  replaceTs?: string | undefined;
  text: string;
  presentation?: SlackMessage | undefined;
  /** Blocks shown under the answer, such as review buttons; the answer text alone stays the message text. */
  blocks?: SlackMessage['blocks'] | undefined;
  agentName?: string | undefined;
  customizeName?: boolean;
  fetcher?: typeof fetch;
}): Promise<BotMessageOutcome> {
  const rendered = input.presentation ?? renderSlackAnswer(input.text);
  const message = input.blocks?.length ? { ...rendered, blocks: [...rendered.blocks, ...input.blocks] } : rendered;
  const username =
    input.customizeName && input.agentName && /^[CG]/.test(input.channel) && !input.replaceTs
      ? `${input.agentName} \u00b7 TulipFarm`
      : undefined;
  const blocks =
    input.agentName && !username
      ? [
          { type: 'context' as const, elements: [{ type: 'plain_text' as const, text: input.agentName }] },
          ...message.blocks,
        ]
      : message.blocks;
  parseSlackSurface({ ...message, blocks });
  try {
    const response = await (input.fetcher ?? fetch)(
      input.replaceTs ? 'https://slack.com/api/chat.update' : 'https://slack.com/api/chat.postMessage',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: input.channel,
          thread_ts: input.rootTs,
          ts: input.replaceTs,
          text: message.text,
          blocks,
          ...(username ? { username } : {}),
          mrkdwn: false,
          parse: 'none',
          link_names: false,
          unfurl_links: false,
          unfurl_media: false,
        }),
      },
    );
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400
        ? { kind: 'retry', seconds }
        : { kind: 'unknown' };
    }
    if (!response.ok || !response.body) return { kind: 'unknown' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 131072) return { kind: 'unknown' };
      chunks.push(chunk);
    }
    const result = z
      .object({
        ok: z.boolean(),
        channel: slackId.optional(),
        ts: z
          .string()
          .regex(/^\d{1,16}\.\d{6}$/)
          .optional(),
        error: z.string().optional(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (result.ok && result.channel === input.channel && result.ts)
      return { kind: 'sent', channel: input.channel, ts: result.ts, text: message.text };
    if (
      !result.ok &&
      [
        'channel_not_found',
        'not_in_channel',
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
