import { z } from 'zod';
import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { slackId } from './contracts.ts';
import type { slackCredentialCipher } from './credentials.ts';
import type { SlackAction, SlackSender } from './action-contracts.ts';
import {
  SlackChannelMembershipError,
  SlackRequesterChannelMembershipError,
  type SlackResolve,
} from './directory-contracts.ts';
import { callSlackApi, SlackApiError } from './web-api.ts';
import { requireSlackInstallationUse } from './installation-access.ts';
import { watchIntegrationRecommendations } from '@tulipfarm/integrations/authorization';
import { slackRecommendations } from './recommendations.ts';
import { normalizeSlackContent, slackContentFields } from './message-content.ts';
export const threadMessageSchema = z.strictObject({
  user: slackId,
  text: z.string().max(40000),
  content: z.string().max(40000).optional(),
  ts: z.string().regex(/^\d{1,16}\.\d{6}$/),
});
export const threadSnapshotSchema = z.array(threadMessageSchema).min(1).max(100);
export type ChannelSource = { installationId: string; generation: number; channel: string; rootTs: string };

type Member = { id: string; slack_user_id: string; credential: unknown; bot_user_id: string; scopes: string[] };
const cursorSchema = z.object({
  response_metadata: z.object({ next_cursor: z.string().max(2048).optional() }).optional(),
});
const nextCursor = (value: unknown) => cursorSchema.parse(value).response_metadata?.next_cursor ?? '';
const replySchema = z
  .object({ user: slackId.optional(), bot_id: slackId.optional(), ...slackContentFields, ts: z.string() })
  .transform(normalizeSlackContent);

export function createChannelProvider(options: {
  appId: string;
  cipher: ReturnType<typeof slackCredentialCipher>;
  fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  async function call(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    source: Pick<ChannelSource, 'installationId' | 'generation'>,
    member: Member,
    method: string,
    params: Record<string, string | number | boolean | undefined>,
    effect?: { completed?: readonly string[] },
  ) {
    let token: string;
    try {
      token = options.cipher.decrypt(
        {
          workspaceId,
          installationId: source.installationId,
          generation: source.generation,
          kind: 'user',
          identityId: member.id,
          membershipId: actor.membershipId,
          slackUserId: member.slack_user_id,
        },
        member.credential,
      );
    } catch {
      throw new SlackApiError('provider-auth-rejected');
    }
    try {
      return await callSlackApi({
        token,
        method,
        params,
        fetcher,
        effect: Boolean(effect),
        ...(effect?.completed ? { completed: effect.completed } : {}),
      });
    } catch (error) {
      if (error instanceof SlackApiError && error.code === 'provider-auth-rejected') {
        await currentMember(tx, actor);
        const recommendations = await watchIntegrationRecommendations(tx, source.installationId, () =>
          slackRecommendations(tx, source.installationId),
        );
        await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_slack_identities')} p SET credential=jsonb_set(p.credential,'{rotation}','{"state":"reconnect-required"}'::jsonb)
          FROM ${qualified(tx.schema, 'tf_slack_installations')} i
          WHERE p.id=$1 AND p.credential=$2::jsonb AND p.state='authorized' AND p.user_id=$3 AND p.membership_id=$4
          AND p.installation_id=$5 AND p.generation=$6 AND i.id=p.installation_id AND i.generation=p.generation AND i.state='active' AND i.app_id=$7`,
          [
            member.id,
            JSON.stringify(member.credential),
            actor.userId,
            actor.membershipId,
            source.installationId,
            source.generation,
            options.appId,
          ],
        );
        await recommendations();
      }
      throw error;
    }
  }
  async function identity(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    source: Pick<ChannelSource, 'installationId' | 'generation'>,
  ) {
    await currentMember(tx, actor);
    await requireSlackInstallationUse(tx, actor, source.installationId);
    const table = (name: string) => qualified(tx.schema, name);
    const row = z
      .object({
        id: z.uuid(),
        slack_user_id: slackId,
        credential: z.unknown(),
        team_id: slackId,
        bot_user_id: slackId,
        scopes: z.array(z.string()),
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT p.id,p.slack_user_id,p.credential,i.team_id,i.bot_user_id,p.scopes FROM ${table('tf_slack_identities')} p
      JOIN ${table('tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation
      WHERE i.id=$1 AND i.generation=$2 AND i.app_id=$3 AND i.state='active' AND i.bot_credential IS NOT NULL AND 'chat:write'=ANY(i.scopes)
      AND p.user_id=$4 AND p.membership_id=$5 AND p.state='authorized' AND p.credential IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${table('tf_slack_user_revocations')} v WHERE v.installation_id=i.id AND v.generation=i.generation AND v.slack_user_id=p.slack_user_id)
      FOR UPDATE OF i`,
            [source.installationId, source.generation, options.appId, actor.userId, actor.membershipId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function observe(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    source: ChannelSource,
    readThread = true,
  ) {
    const member = await identity(tx, actor, source);
    if (
      !member.scopes.includes('im:history') ||
      !member.scopes.includes(
        source.channel.startsWith('D')
          ? 'im:history'
          : source.channel.startsWith('G')
            ? 'groups:history'
            : 'channels:history',
      )
    )
      throw new AccessDenied();
    const info = z
      .object({
        channel: z.object({
          id: slackId,
          name: z.string().min(1).max(120).optional(),
          is_archived: z.boolean().optional(),
        }),
      })
      .parse(await call(tx, workspaceId, actor, source, member, 'conversations.info', { channel: source.channel }));
    if (info.channel.id !== source.channel || info.channel.is_archived === true) throw new AccessDenied();
    const members: string[] = [];
    const cursors = new Set<string>();
    let cursor = '';
    for (let page = 0; ; page++) {
      if (page >= 100) throw new AccessDenied();
      const result = await call(tx, workspaceId, actor, source, member, 'conversations.members', {
        channel: source.channel,
        limit: 1000,
        cursor: cursor || undefined,
      });
      members.push(...z.object({ members: z.array(slackId).max(1000) }).parse(result).members);
      if (members.length > 10000) throw new AccessDenied();
      const next = nextCursor(result);
      if (!next) break;
      if (cursors.has(next)) throw new AccessDenied();
      cursors.add(next);
      cursor = next;
    }
    if (!members.includes(member.slack_user_id)) throw new SlackRequesterChannelMembershipError();
    if (!members.includes(member.bot_user_id)) throw new SlackChannelMembershipError();
    const audience = {
      members: [...new Set(members)].sort(),
      botUserId: member.bot_user_id,
      archiveVerified: info.channel.is_archived === false,
      channelName: info.channel.name ?? null,
      teamId: member.team_id,
    };
    if (!readThread) return { identityId: member.id, slackUserId: member.slack_user_id, messages: [], ...audience };
    const thread = z.object({ messages: z.array(z.unknown()).max(100), has_more: z.boolean().optional() }).parse(
      await call(tx, workspaceId, actor, source, member, 'conversations.replies', {
        channel: source.channel,
        ts: source.rootTs,
        limit: 100,
      }),
    );
    if (thread.has_more) throw new AccessDenied();
    const messages = threadSnapshotSchema.parse(
      thread.messages
        .map(value => replySchema.parse(value))
        .filter(message => message.user ?? message.bot_id)
        .map(message => ({
          user: message.user ?? message.bot_id,
          text: message.text,
          ts: message.ts,
          ...(message.content !== undefined ? { content: message.content } : {}),
        })),
    );
    if (
      new Set(messages.map(message => message.ts)).size !== messages.length ||
      !messages.some(message => message.ts === source.rootTs) ||
      Buffer.byteLength(JSON.stringify(messages)) > 24000
    )
      throw new AccessDenied();
    return { identityId: member.id, slackUserId: member.slack_user_id, messages, ...audience };
  }
  async function appToken(
    tx: AuthorizationTransaction,
    workspaceId: string,
    source: Pick<ChannelSource, 'installationId' | 'generation'>,
    scope: string,
  ) {
    const row = z
      .object({ bot_credential: z.unknown(), scopes: z.array(z.string()) })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT bot_credential,scopes FROM ${qualified(tx.schema, 'tf_slack_installations')}
      WHERE id=$1 AND generation=$2 AND app_id=$3 AND state='active' AND bot_credential IS NOT NULL`,
            [source.installationId, source.generation, options.appId],
          )
        ).rows[0],
      );
    if (!row?.scopes.includes(scope)) throw new AccessDenied();
    try {
      return options.cipher.decrypt(
        { workspaceId, installationId: source.installationId, generation: source.generation, kind: 'bot' },
        row.bot_credential,
      );
    } catch {
      throw new SlackApiError('authorization-denied');
    }
  }
  async function dispatch(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    source: ChannelSource,
    action: SlackAction,
    authorize: () => Promise<void>,
    sender: SlackSender = 'user',
  ) {
    const member = await identity(tx, actor, source);
    const scope = action.tool === 'slack.reaction.add' ? 'reactions:write' : 'chat:write';
    if (!member.scopes.includes(scope)) throw new AccessDenied();
    const token = sender === 'app' ? await appToken(tx, workspaceId, source, scope) : null;
    try {
      await authorize();
      if ((await identity(tx, actor, source)).id !== member.id) throw new AccessDenied();
    } catch {
      throw new SlackApiError('authorization-denied');
    }
    // The requester's linked identity still authorizes every send; 'app' only changes the posting token.
    const send = (
      method: string,
      params: Record<string, string | boolean>,
      effect: { completed?: readonly string[] },
    ) =>
      token
        ? callSlackApi({
            token,
            method,
            params,
            fetcher,
            effect: true,
            ...(effect.completed ? { completed: effect.completed } : {}),
          })
        : call(tx, workspaceId, actor, source, member, method, params, effect);
    switch (action.tool) {
      case 'slack.message.send':
        return z
          .object({ ts: z.string().regex(/^\d{1,16}\.\d{6}$/) })
          .parse(
            await send(
              'chat.postMessage',
              { channel: source.channel, text: action.text, unfurl_links: false, unfurl_media: false },
              {},
            ),
          ).ts;
      case 'slack.thread.reply':
        return z.object({ ts: z.string().regex(/^\d{1,16}\.\d{6}$/) }).parse(
          await send(
            'chat.postMessage',
            {
              channel: source.channel,
              text: action.text,
              thread_ts: action.threadTs,
              unfurl_links: false,
              unfurl_media: false,
            },
            {},
          ),
        ).ts;
      case 'slack.reaction.add':
        await send(
          'reactions.add',
          { channel: source.channel, timestamp: action.messageTs, name: action.reaction },
          { completed: ['already_reacted'] },
        );
        return;
    }
  }
  async function search(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    source: Pick<ChannelSource, 'installationId' | 'generation'>,
    input: SlackResolve,
  ) {
    const member = await identity(tx, actor, source);
    const query = input.name.replace(/^[#@]/, '').trim();
    const needle = query.toLowerCase();
    const matches = new Map<string, { id: string; name: string; exact: boolean }>();
    const cursors = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const result =
        input.kind === 'channel'
          ? await call(tx, workspaceId, actor, source, member, 'conversations.list', {
              types: 'public_channel,private_channel',
              exclude_archived: true,
              limit: 200,
              cursor: cursor || undefined,
            })
          : await call(tx, workspaceId, actor, source, member, 'users.list', {
              limit: 200,
              cursor: cursor || undefined,
            });
      const candidates =
        input.kind === 'channel'
          ? z
              .object({
                channels: z.array(z.object({ id: slackId.regex(/^[CG]/), name: z.string().min(1).max(120) })).max(1000),
              })
              .parse(result)
              .channels.map(item => ({ id: item.id, names: [item.name] }))
          : z
              .object({
                members: z
                  .array(
                    z.object({
                      id: slackId.regex(/^[UW]/),
                      name: z.string().max(120),
                      deleted: z.boolean().optional(),
                      is_bot: z.boolean().optional(),
                      real_name: z.string().max(120).optional(),
                      profile: z
                        .object({
                          display_name: z.string().max(120).optional(),
                          real_name: z.string().max(120).optional(),
                        })
                        .optional(),
                    }),
                  )
                  .max(1000),
              })
              .parse(result)
              .members.filter(item => !item.deleted && !item.is_bot && item.id !== 'USLACKBOT')
              .map(item => ({
                id: item.id,
                names: [item.profile?.display_name, item.profile?.real_name, item.real_name, item.name].filter(
                  (name): name is string => Boolean(name),
                ),
              }));
      for (const candidate of candidates) {
        const exact = candidate.id === query || candidate.names.some(name => name.toLowerCase() === needle);
        if (exact || candidate.names.some(name => name.toLowerCase().includes(needle)))
          matches.set(candidate.id, { id: candidate.id, name: candidate.names[0] ?? candidate.id, exact });
      }
      const next = nextCursor(result);
      if (!next) {
        await identity(tx, actor, source);
        const found = [...matches.values()];
        const exact = found.filter(item => item.exact);
        const selected = (exact.length ? exact : found).map(({ id, name }) => ({ id, name }));
        return {
          matches: selected.slice(0, 20),
          status:
            exact.length === 1
              ? ('resolved' as const)
              : selected.length
                ? ('ambiguous' as const)
                : ('not-found' as const),
        };
      }
      if (cursors.has(next)) break;
      cursors.add(next);
      cursor = next;
    }
    return {
      error: 'lookup-incomplete' as const,
      instruction: 'Slack returned an incomplete directory listing. Narrow the name and try again; do not guess an ID.',
    };
  }
  async function authors(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    source: ChannelSource,
    messages: z.infer<typeof threadSnapshotSchema>,
  ) {
    const member = await identity(tx, actor, source);
    const names: Record<string, string> = {};
    for (const id of new Set(messages.map(message => message.user))) {
      if (!member.scopes.includes('users:read')) {
        names[id] = '[Name unavailable: users:read permission missing]';
        continue;
      }
      if (id.startsWith('B')) {
        const result = z
          .object({ bot: z.object({ id: slackId, name: z.string().max(256) }) })
          .parse(await call(tx, workspaceId, actor, source, member, 'bots.info', { bot: id }));
        if (result.bot.id !== id) throw new AccessDenied();
        names[id] = result.bot.name;
      } else {
        const result = z
          .object({
            user: z.object({
              id: slackId,
              name: z.string().max(256).optional(),
              real_name: z.string().max(256).optional(),
              profile: z
                .object({ display_name: z.string().max(256).optional(), real_name: z.string().max(256).optional() })
                .optional(),
            }),
          })
          .parse(await call(tx, workspaceId, actor, source, member, 'users.info', { user: id }));
        if (result.user.id !== id) throw new AccessDenied();
        names[id] =
          result.user.profile?.display_name ||
          result.user.profile?.real_name ||
          result.user.real_name ||
          result.user.name ||
          '[Name unavailable]';
      }
    }
    return names;
  }
  return { observe, identity, dispatch, search, authors };
}
