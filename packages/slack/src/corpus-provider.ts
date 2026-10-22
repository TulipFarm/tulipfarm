import { createHash } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  SlackCorpusError,
  slackConversationIdSchema,
  slackCorpusBindingSchema,
  slackCorpusCursorTokenSchema,
  slackCorpusKindSchema,
  slackCorpusLimits as limits,
  slackCorpusSelectionSchema,
  slackHistoryScopes,
  slackTimestampSchema,
  type SlackConversation,
  type SlackConversationKind,
  type SlackCorpusBinding,
  type SlackCorpusErrorCode,
  type SlackCorpusKind,
  type SlackCorpusProvider,
  type SlackCorpusSelection,
  type SlackThreadObservation,
} from '@tulipfarm/knowledge/slack-contracts';
import { slackCredentialCipher } from './credentials.ts';
import { canAccessSlackInstallation } from './installation-access.ts';
import { slackConfigurationSchema } from './contracts.ts';
import type { SlackRuntime } from './installations.ts';
import { normalizeSlackContent, slackContentFields, slackMessageText } from './message-content.ts';

const channelSchema = z.object({
  id: slackConversationIdSchema,
  name: z.string().max(256).optional(),
  user: z.string().max(64).optional(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  is_private: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  is_member: z.boolean().optional(),
});
type Channel = z.infer<typeof channelSchema>;
const messageSchema = z
  .object({
    ts: slackTimestampSchema,
    thread_ts: slackTimestampSchema.optional(),
    user: z.string().max(64).optional(),
    bot_id: z.string().max(64).optional(),
    ...slackContentFields,
    subtype: z.string().max(64).optional(),
    reply_count: z.number().int().nonnegative().optional(),
    edited: z.object({ ts: slackTimestampSchema }).optional(),
  })
  .transform(normalizeSlackContent);
type Message = z.infer<typeof messageSchema>;
const metadataSchema = z.object({ next_cursor: z.string().max(4096).optional() }).optional();
const ignoredSubtype = /^(?:channel|group)_|^(?:pinned|unpinned)_item$|^bot_(?:add|remove)$|^reminder_add$/;
const errorCodes: Record<string, SlackCorpusErrorCode> = {
  ratelimited: 'rate-limited',
  channel_not_found: 'forbidden',
  not_in_channel: 'not-member',
  is_archived: 'archived',
  thread_not_found: 'not-found',
  message_not_found: 'not-found',
  missing_scope: 'insufficient-scope',
  no_permission: 'forbidden',
  invalid_auth: 'unauthenticated',
  not_authed: 'unauthenticated',
  token_revoked: 'unauthenticated',
  token_expired: 'unauthenticated',
  account_inactive: 'unauthenticated',
  invalid_cursor: 'invalid-cursor',
  internal_error: 'transient',
  fatal_error: 'transient',
  service_unavailable: 'transient',
  request_timeout: 'transient',
};

function parse<T>(schema: z.ZodType<T>, value: unknown, code: SlackCorpusErrorCode = 'invalid-response'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SlackCorpusError(code);
  return result.data;
}
function kindOf(channel: Channel): SlackConversationKind {
  return channel.is_im ? 'im' : channel.is_mpim ? 'mpim' : channel.is_private ? 'private' : 'public';
}
function titleOf(channel: Channel) {
  const kind = kindOf(channel);
  if (kind === 'im') return `Direct message with ${channel.user ?? channel.id}`;
  if (kind === 'mpim') return `Group message ${channel.name ?? channel.id}`;
  return `#${channel.name ?? channel.id}`;
}
function conversation(channel: Channel): SlackConversation {
  return { conversationId: channel.id, kind: kindOf(channel), title: titleOf(channel).slice(0, 512) };
}
function hasScopes(scopes: readonly string[], kind: SlackConversationKind) {
  return slackHistoryScopes[kind].every(scope => scopes.includes(scope));
}
function time(ts: string) {
  const [seconds = '0', micros = '0'] = ts.split('.');
  return new Date(Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)).toISOString();
}
function epoch(date: string) {
  return `${Math.floor(Date.parse(date) / 1000)}.000000`;
}
function compare(left: string, right: string) {
  const [a = '', b = ''] = left.split('.');
  const [c = '', d = ''] = right.split('.');
  return BigInt(a) === BigInt(c) ? Number(BigInt(b) - BigInt(d)) : BigInt(a) < BigInt(c) ? -1 : 1;
}
function text(value: string) {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .split('\n')
    .map(line => (/^\s{0,3}(?:#|>|[-*+] |\d+[.)] |```|~~~)/.test(line) ? `\\${line.trimStart()}` : line))
    .join('\n');
}
function author(message: Message) {
  return message.user ?? (message.bot_id ? `bot ${message.bot_id}` : 'unknown author');
}
function withheldFromKnowledge(message: Message) {
  return message.bot_id !== undefined || message.subtype === 'bot_message';
}
export function slackThreadRevision(messages: readonly Message[]) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        messages.map(message => [
          message.ts,
          message.user ?? message.bot_id ?? '',
          message.subtype ?? '',
          message.edited?.ts ?? '',
          withheldFromKnowledge(message)
            ? 'withheld'
            : createHash('sha256').update(slackMessageText(message)).digest('hex'),
        ]),
      ),
    )
    .digest('hex')
    .slice(0, 48);
}
function threadTitle(channel: Channel, root: Message) {
  const snippet =
    (root.subtype === 'tombstone'
      ? 'Deleted message'
      : withheldFromKnowledge(root)
        ? 'Bot message'
        : slackMessageText(root).replace(/\s+/g, ' ').trim()
    ).slice(0, 80) || 'Message';
  return `${titleOf(channel)} · ${time(root.ts).slice(0, 10)} · ${snippet}`.slice(0, 512);
}
export function serializeSlackThread(channel: Channel, messages: readonly Message[]) {
  const [root] = messages;
  if (!root) throw new SlackCorpusError('not-found');
  const lines = [
    `# ${threadTitle(channel, root).replaceAll('\n', ' ')}`,
    '',
    `Slack conversation ${titleOf(channel)} (${channel.id}), thread ${root.ts}. ${messages.length === 1 ? 'Single message.' : `${messages.length - 1} ${messages.length === 2 ? 'reply' : 'replies'}.`}`,
  ];
  for (const [index, message] of messages.entries()) {
    lines.push(
      '',
      `## ${index === 0 ? 'Message' : 'Reply'} by ${author(message)} at ${time(message.ts)}${message.edited ? ` (edited ${time(message.edited.ts)})` : ''}`,
      '',
    );
    lines.push(
      message.subtype === 'tombstone'
        ? '_This message was deleted._'
        : withheldFromKnowledge(message)
          ? '_Bot message withheld from Knowledge._'
          : slackMessageText(message).trim()
            ? text(slackMessageText(message))
            : '_No text content._',
    );
  }
  const markdown = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new SlackCorpusError('thread-too-large');
  return markdown;
}

export type SlackCorpusCredential = { binding: SlackCorpusBinding; token: string; scopes: string[] };
export type SlackCorpusCredentials = (workspaceId: string, userId: string) => Promise<SlackCorpusCredential>;

// Resolves the caller's own linked Slack user token. Every corpus request is made with this identity only.
export function slackCorpusCredentials(options: {
  runtime: SlackRuntime;
  appId: string;
  cipher: ReturnType<typeof slackCredentialCipher>;
}): SlackCorpusCredentials {
  return (workspaceId, userId) =>
    options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'read');
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      const table = (name: string) => qualified(tx.schema, name);
      const row = z
        .object({
          id: z.uuid(),
          slack_user_id: z.string(),
          credential: z.unknown(),
          scopes: z.array(z.string()),
          installation_id: z.uuid(),
          generation: z.number().int(),
          team_id: z.string(),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT p.id,p.slack_user_id,p.credential,p.scopes,p.installation_id,p.generation,i.team_id
      FROM ${table('tf_slack_identities')} p JOIN ${table('tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation
      WHERE i.state='active' AND i.app_id=$1 AND p.user_id=$2 AND p.membership_id=$3 AND p.state='authorized' AND p.credential IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${table('tf_slack_user_revocations')} v WHERE v.installation_id=i.id AND v.generation=i.generation AND v.slack_user_id=p.slack_user_id)`,
              [options.appId, actor.userId, actor.membershipId],
            )
          ).rows[0],
        );
      if (!row) throw new SlackCorpusError('not-linked');
      // A linked identity outlives grant changes, so each use rechecks the installation grant.
      if (!(await canAccessSlackInstallation(tx, actor, row.installation_id, 'use')))
        throw new SlackCorpusError('not-linked');
      const binding = parse(slackCorpusBindingSchema, {
        installationId: row.installation_id,
        installationGeneration: row.generation,
        identityId: row.id,
        slackUserId: row.slack_user_id,
        teamId: row.team_id,
      });
      let token: string;
      try {
        token = options.cipher.decrypt(
          {
            workspaceId,
            installationId: row.installation_id,
            generation: row.generation,
            kind: 'user',
            identityId: row.id,
            membershipId: actor.membershipId,
            slackUserId: row.slack_user_id,
          },
          row.credential,
        );
      } catch {
        throw new SlackCorpusError('reconnect-required');
      }
      return { binding, token, scopes: row.scopes };
    });
}

export function createSlackCorpusProvider(options: {
  credentials: SlackCorpusCredentials;
  fetcher?: typeof fetch;
}): SlackCorpusProvider {
  const fetcher = observeFetch('slack', 'request', options.fetcher ?? fetch);
  async function credential(workspaceId: string, userId: string, expected?: SlackCorpusBinding) {
    let current: SlackCorpusCredential;
    try {
      current = await options.credentials(workspaceId, userId);
    } catch (error) {
      if (error instanceof SlackCorpusError) throw error;
      throw new SlackCorpusError(error instanceof AccessDenied ? 'not-linked' : 'transient');
    }
    if (
      expected &&
      JSON.stringify(parse(slackCorpusBindingSchema, expected, 'stale-integration')) !==
        JSON.stringify(parse(slackCorpusBindingSchema, current.binding))
    )
      throw new SlackCorpusError('stale-integration');
    return current;
  }
  async function call(token: string, method: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`https://slack.com/api/${method}`);
    url.search = new URLSearchParams(query).toString();
    const signal = AbortSignal.timeout(limits.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw new SlackCorpusError('transient');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > limits.responseBytes)
        throw new SlackCorpusError('response-too-large');
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limits.responseBytes) throw new SlackCorpusError('response-too-large');
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof SlackCorpusError) throw error;
      throw new SlackCorpusError('transient');
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
    const retry = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retry) && retry >= 0 ? Math.min(3_600_000, Math.ceil(retry * 1000)) : null;
    if (response.status === 429) throw new SlackCorpusError('rate-limited', retryAfterMs);
    if (response.status >= 500) throw new SlackCorpusError('transient', retryAfterMs);
    if (response.status === 401) throw new SlackCorpusError('unauthenticated');
    if (response.status !== 200) throw new SlackCorpusError('invalid-response');
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new SlackCorpusError('invalid-response');
    }
    const body = parse(z.record(z.string(), z.unknown()), value);
    if (body.ok !== true) {
      const code = typeof body.error === 'string' ? errorCodes[body.error] : undefined;
      throw new SlackCorpusError(code ?? 'invalid-response', code === 'rate-limited' ? retryAfterMs : null);
    }
    return body;
  }
  async function info(token: string, conversationId: string) {
    const channel = parse(
      channelSchema,
      (
        await call(token, 'conversations.info', {
          channel: parse(slackConversationIdSchema, conversationId, 'invalid-selection'),
        })
      ).channel,
    );
    if (channel.id !== conversationId) throw new SlackCorpusError('invalid-response');
    return channel;
  }
  async function thread(token: string, conversationId: string, ts: string) {
    const messages: Message[] = [];
    let cursor = '';
    for (let page = 0; page < limits.threadPages; page++) {
      const body = await call(token, 'conversations.replies', {
        channel: conversationId,
        ts,
        limit: '200',
        inclusive: 'true',
        ...(cursor ? { cursor } : {}),
      });
      const batch = parse(z.array(messageSchema).max(1000), body.messages);
      if (page === 0 && (batch[0]?.ts !== ts || (batch[0].thread_ts && batch[0].thread_ts !== ts)))
        throw new SlackCorpusError('not-found');
      for (const message of batch) if (!messages.some(item => item.ts === message.ts)) messages.push(message);
      if (messages.length > limits.threadMessages) return { messages, complete: false };
      const next = parse(metadataSchema, body.response_metadata)?.next_cursor ?? '';
      if (body.has_more !== true) return { messages, complete: true };
      if (!next || next === cursor) throw new SlackCorpusError('invalid-response');
      cursor = next;
    }
    return { messages, complete: false };
  }
  function observation(
    binding: SlackCorpusBinding,
    channel: Channel,
    messages: Message[],
    complete: boolean,
    accessedAt: string,
  ): SlackThreadObservation {
    const root = messages[0];
    if (!root) throw new SlackCorpusError('not-found');
    return {
      nativeId: `${channel.id}:${root.ts}`,
      conversationId: channel.id,
      ts: root.ts,
      title: threadTitle(channel, root),
      canonicalURL: `https://app.slack.com/client/${binding.teamId}/${channel.id}/thread/${channel.id}-${root.ts}`,
      sourceRevision: slackThreadRevision(messages),
      accessedAt,
      coverage: complete ? 'supported' : 'thread-too-large',
    };
  }
  return {
    async discover(workspaceId: string, userId: string, kind: SlackCorpusKind, cursor?: string) {
      kind = parse(slackCorpusKindSchema, kind, 'invalid-selection');
      if (cursor !== undefined) cursor = parse(slackCorpusCursorTokenSchema, cursor, 'invalid-cursor');
      const { binding, token, scopes } = await credential(workspaceId, userId);
      const allowed = (kind === 'channels' ? (['public', 'private'] as const) : (['im', 'mpim'] as const)).filter(
        item => hasScopes(scopes, item),
      );
      if (!allowed.length) throw new SlackCorpusError('insufficient-scope');
      const types = allowed
        .map(item => ({ public: 'public_channel', private: 'private_channel', im: 'im', mpim: 'mpim' })[item])
        .join(',');
      const body = await call(token, 'users.conversations', {
        types,
        exclude_archived: 'true',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      const channels = parse(z.array(channelSchema).max(1000), body.channels);
      const next = parse(metadataSchema, body.response_metadata)?.next_cursor || null;
      return {
        binding,
        items: channels
          .filter(channel => !channel.is_archived && (allowed as readonly string[]).includes(kindOf(channel)))
          .map(conversation),
        nextCursor: next ? parse(slackCorpusCursorTokenSchema, next) : null,
      };
    },
    async inspectSelection(workspaceId: string, userId: string, input: SlackCorpusSelection) {
      const selection = parse(slackCorpusSelectionSchema, input, 'invalid-selection');
      const { binding, token, scopes } = await credential(workspaceId, userId);
      const conversations: SlackConversation[] = [];
      for (const id of selection.conversationIds) {
        const channel = await info(token, id);
        const kind = kindOf(channel);
        if (channel.is_archived) throw new SlackCorpusError('archived');
        if ((selection.kind === 'channels') !== (kind === 'public' || kind === 'private'))
          throw new SlackCorpusError('wrong-kind');
        if ((kind === 'public' || kind === 'private') && channel.is_member !== true)
          throw new SlackCorpusError('not-member');
        if (!hasScopes(scopes, kind)) throw new SlackCorpusError('insufficient-scope');
        conversations.push(conversation(channel));
      }
      const [first] = conversations;
      if (!first) throw new SlackCorpusError('invalid-selection');
      return {
        binding,
        conversations,
        title: conversations.length === 1 ? first.title : `${first.title} and ${conversations.length - 1} more`,
      };
    },
    async access(workspaceId: string, userId: string, expected: SlackCorpusBinding, conversationId: string) {
      const { token, scopes } = await credential(workspaceId, userId, expected);
      const accessedAt = new Date().toISOString();
      const channel = await info(token, conversationId);
      const kind = kindOf(channel);
      if (!hasScopes(scopes, kind)) throw new SlackCorpusError('insufficient-scope');
      return {
        ...conversation(channel),
        accessedAt,
        archived: channel.is_archived === true,
        member: kind === 'im' || kind === 'mpim' ? true : channel.is_member === true,
      };
    },
    async list(
      workspaceId: string,
      userId: string,
      expected: SlackCorpusBinding,
      conversationId: string,
      after: string,
      cursor: string | null,
    ) {
      const { binding, token } = await credential(workspaceId, userId, expected);
      if (cursor !== null) cursor = parse(slackCorpusCursorTokenSchema, cursor, 'invalid-cursor');
      const channel = await info(token, conversationId);
      const accessedAt = new Date().toISOString();
      const body = await call(token, 'conversations.history', {
        channel: conversationId,
        oldest: epoch(after),
        inclusive: 'true',
        limit: String(limits.historyPageSize),
        ...(cursor ? { cursor } : {}),
      });
      const messages = parse(z.array(messageSchema).max(limits.historyPageSize * 10), body.messages);
      const observations: SlackThreadObservation[] = [];
      for (const message of messages) {
        if (
          (message.thread_ts && message.thread_ts !== message.ts) ||
          (message.subtype && ignoredSubtype.test(message.subtype))
        )
          continue;
        if (compare(message.ts, epoch(after)) < 0) continue;
        const replies = message.reply_count
          ? await thread(token, conversationId, message.ts)
          : { messages: [message], complete: true };
        observations.push(observation(binding, channel, replies.messages, replies.complete, accessedAt));
      }
      const next = parse(metadataSchema, body.response_metadata)?.next_cursor ?? '';
      if (body.has_more === true && !next) throw new SlackCorpusError('invalid-response');
      return { observations, nextCursor: body.has_more === true ? parse(slackCorpusCursorTokenSchema, next) : null };
    },
    async read(
      workspaceId: string,
      userId: string,
      expected: SlackCorpusBinding,
      conversationId: string,
      ts: string,
      after: string,
    ) {
      const { binding, token } = await credential(workspaceId, userId, expected);
      ts = parse(slackTimestampSchema, ts, 'invalid-selection');
      if (compare(ts, epoch(after)) < 0) throw new SlackCorpusError('outside-selection');
      const accessedAt = new Date().toISOString();
      const channel = await info(token, conversationId);
      const result = await thread(token, conversationId, ts);
      if (!result.complete) throw new SlackCorpusError('thread-too-large');
      const root = result.messages[0];
      if (!root || (root.subtype && ignoredSubtype.test(root.subtype))) throw new SlackCorpusError('not-found');
      return {
        ...observation(binding, channel, result.messages, true, accessedAt),
        markdown: serializeSlackThread(channel, result.messages),
      };
    },
  };
}

const unconfigured = async (): Promise<never> => {
  throw new SlackCorpusError('not-configured');
};
export const unconfiguredSlackCorpusProvider: SlackCorpusProvider = {
  discover: unconfigured,
  inspectSelection: unconfigured,
  access: unconfigured,
  list: unconfigured,
  read: unconfigured,
};

// Reuses the existing Slack app configuration and credential keys. Missing or unusable configuration reports not-configured instead of blocking API startup.
export function slackCorpusFromEnvironment(options: {
  runtime: SlackRuntime;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
}): SlackCorpusProvider {
  const env = options.env ?? process.env;
  if (!env.SLACK_CONFIGURATION || !env.SLACK_CREDENTIAL_KEYS) return unconfiguredSlackCorpusProvider;
  try {
    const config = slackConfigurationSchema.parse(JSON.parse(env.SLACK_CONFIGURATION));
    if (!config.memberLinking) return unconfiguredSlackCorpusProvider;
    const cipher = slackCredentialCipher(JSON.parse(env.SLACK_CREDENTIAL_KEYS));
    return createSlackCorpusProvider({
      credentials: slackCorpusCredentials({ runtime: options.runtime, appId: config.appId, cipher }),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  } catch {
    return unconfiguredSlackCorpusProvider;
  }
}
