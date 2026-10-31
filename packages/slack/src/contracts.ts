import { z } from 'zod';
import { normalizeSlackContent, slackContentFields } from './message-content.ts';

export const slackId = z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/);
const timestamp = z.string().regex(/^\d{1,16}\.\d{6}$/);
const callbackUri = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
export const slackConfigurationSchema = z.strictObject({
  appId: slackId,
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  signingSecret: z.string().min(16),
  redirectUri: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }),
  scopeApproval: z.strictObject({
    reference: z.string().min(1).max(256),
    botScopes: z
      .array(z.string().regex(/^[a-z][a-z0-9_.:-]+$/))
      .min(1)
      .max(100),
  }),
  memberLinking: z
    .strictObject({
      identityRedirectUri: callbackUri,
      operationalRedirectUri: callbackUri,
      distribution: z.enum(['internal', 'marketplace']),
      scopeApproval: z.strictObject({
        reference: z.string().min(1).max(256),
        userScopes: z
          .array(z.string().regex(/^[a-z][a-z0-9_.:-]+$/))
          .min(1)
          .max(100)
          .refine(
            scopes =>
              !scopes.some(scope => ['openid', 'email', 'profile'].includes(scope)) &&
              ['channels:history', 'groups:history', 'im:history', 'mpim:history'].every(scope =>
                scopes.includes(scope),
              ),
          ),
      }),
    })
    .optional(),
});
export type SlackConfiguration = z.infer<typeof slackConfigurationSchema>;

/** The bot scope that lets TulipFarm download files people share with it in Slack. */
export const slackFileScope = 'files:read';
/** The bot scope that lets TulipFarm upload the images a run generated to the Slack destination it delivers to. */
export const slackFileUploadScope = 'files:write';

/** The bot scope that lets TulipFarm put a long laid-out reply in a Slack canvas. */
export const slackCanvasScope = 'canvases:write';
/** The bot scope for Slack's agent features: streamed progress, suggested prompts and thread titles. */
export const slackAssistantScope = 'assistant:write';

/**
 * The bot scopes an installation needs. While the `images` flag is on, reading shared files adds `files:read` and
 * delivering generated images adds `files:write`. While the `generative-ui` flag is on, canvases add `canvases:write`
 * and agent features add `assistant:write`. While the `slack-reactions` flag is on, reaction rules add `reactions:read`
 * and the emoji picker adds `emoji:read`. An installation without them shows the notice to update Slack permissions.
 */
export function requiredBotScopes(
  config: Pick<SlackConfiguration, 'scopeApproval'>,
  images: boolean,
  generativeUi = false,
  reactions = false,
) {
  const scopes = config.scopeApproval.botScopes;
  const extra = [
    ...(images ? [slackFileScope, slackFileUploadScope] : []),
    ...(generativeUi ? [slackCanvasScope, slackAssistantScope] : []),
    ...(reactions ? ['reactions:read', 'emoji:read'] : []),
  ];
  return [...scopes, ...extra.filter(scope => !scopes.includes(scope))];
}
export const eventEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_verification'), challenge: z.string().min(1).max(1024) }),
  z.object({
    type: z.literal('event_callback'),
    api_app_id: slackId,
    team_id: slackId,
    event_id: z.string().min(1).max(128),
    event_time: z.number().int().nonnegative().safe(),
    event: z.object({ type: z.string().min(1).max(128) }).passthrough(),
  }),
]);
export type SlackEvent = Extract<z.infer<typeof eventEnvelopeSchema>, { type: 'event_callback' }>;
export const messageSchema = z
  .object({
    type: z.enum(['message', 'app_mention']),
    user: slackId,
    channel: slackId,
    ts: timestamp,
    thread_ts: timestamp.optional(),
    ...slackContentFields,
    bot_id: slackId.optional(),
    subtype: z.string().optional(),
  })
  .transform(normalizeSlackContent);
const changedSchema = z.object({
  type: z.literal('message'),
  subtype: z.literal('message_changed'),
  channel: slackId,
  event_ts: timestamp,
  message: z
    .object({
      user: slackId,
      ts: timestamp,
      thread_ts: timestamp.optional(),
      ...slackContentFields,
      edited: z.object({ ts: timestamp }).optional(),
    })
    .transform(normalizeSlackContent),
});
const deletedSchema = z.object({
  type: z.literal('message'),
  subtype: z.literal('message_deleted'),
  channel: slackId,
  event_ts: timestamp,
  deleted_ts: timestamp,
});
const reactionSchema = z.object({
  type: z.literal('reaction_added'),
  user: slackId,
  reaction: z.string().regex(/^[a-z0-9_+'-]{1,100}(::skin-tone-[2-6])?$/),
  item: z.object({ type: z.literal('message'), channel: slackId, ts: timestamp }),
  event_ts: timestamp,
});
export type SlackReactionEvent = z.infer<typeof reactionSchema>;
const revokedSchema = z.object({
  type: z.literal('tokens_revoked'),
  tokens: z.object({ oauth: z.array(slackId).max(1000).default([]), bot: z.array(slackId).max(1000).default([]) }),
});

export function classifyEvent(envelope: SlackEvent) {
  if (envelope.event.type === 'message' && envelope.event.subtype === 'message_changed')
    return { kind: 'message-change' as const, event: changedSchema.parse(envelope.event) };
  if (envelope.event.type === 'message' && envelope.event.subtype === 'message_deleted')
    return { kind: 'message-change' as const, event: deletedSchema.parse(envelope.event) };
  if (envelope.event.type === 'tokens_revoked')
    return { kind: 'revocation' as const, event: revokedSchema.parse(envelope.event) };
  if (envelope.event.type === 'app_uninstalled') return { kind: 'uninstall' as const };
  if (envelope.event.type === 'reaction_added') {
    const reaction = reactionSchema.safeParse(envelope.event);
    return reaction.success ? { kind: 'reaction' as const, event: reaction.data } : { kind: 'ignored' as const };
  }
  const message = messageSchema.safeParse(envelope.event);
  if (message.success && !message.data.bot_id && (!message.data.subtype || message.data.subtype === 'file_share'))
    return { kind: 'message' as const, event: message.data };
  return { kind: 'ignored' as const };
}
