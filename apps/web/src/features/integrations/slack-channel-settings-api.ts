import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { IntegrationRequestError } from '@/lib/integrations';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';

export const slackReplyRules = ['tag', 'every-message'] as const;
export type SlackReplyRule = (typeof slackReplyRules)[number];

/** A Slack emoji short name, standard or custom, optionally with a skin tone. */
export const slackReactionNameSchema = z.string().regex(/^[a-z0-9_+'-]{1,100}(::skin-tone-[2-6])?$/);

export const maxReactionRules = 5;
export const maxReactionPromptLength = 2000;

/** The agent runs `prompt` on the reacted message and its thread, with the tools it already has. */
const reactionRuleSchema = z.object({
  reaction: slackReactionNameSchema,
  prompt: z.string().trim().min(1).max(maxReactionPromptLength),
});
export type SlackReactionRule = z.infer<typeof reactionRuleSchema>;

const channelSchema = z.object({
  id: z.string().regex(/^[CG][A-Z0-9]{1,63}$/),
  name: z.string().min(1),
  private: z.boolean(),
  /** `null` when Slack didn't report a count. */
  members: z.number().int().nonnegative().nullable(),
  botMember: z.boolean(),
  /** `null` uses the workspace default agent. */
  agentId: z.uuid().nullable(),
  replies: z.enum(slackReplyRules),
  reactions: z.array(reactionRuleSchema).max(maxReactionRules),
  version: z.number().int().nonnegative(),
});
export type SlackChannelSetting = z.infer<typeof channelSchema>;

const settingsSchema = z.object({
  canManage: z.boolean(),
  channels: z.array(channelSchema),
  agents: z.array(z.object({ id: z.uuid(), name: z.string().min(1) })),
  /** Bot scopes the channel list needs but the installation lacks. */
  missingScopes: z.array(z.string()).default([]),
});
export type SlackChannelSettings = z.infer<typeof settingsSchema>;

export type SlackChannelChange = Pick<SlackChannelSetting, 'agentId' | 'replies' | 'reactions'>;

export class SlackChannelConflict extends Error {}

const base = (workspaceId: string) => `${apiOrigin}/v1/workspaces/${workspaceId}/slack/channel-settings`;

export async function loadSlackChannelSettings(workspaceId: string, signal?: AbortSignal) {
  const response = await jsonResponse(base(workspaceId), { signal: requestSignal(signal), cache: 'no-store' });
  if (!response.ok) throw new IntegrationRequestError(response.status);
  return settingsSchema.parse(await readJson(response));
}

export async function saveSlackChannelSetting(
  workspaceId: string,
  channelId: string,
  expectedVersion: number,
  change: SlackChannelChange,
) {
  const response = await jsonResponse(`${base(workspaceId)}/${encodeURIComponent(channelId)}`, {
    method: 'PUT',
    signal: requestSignal(),
    body: { expectedVersion, ...change },
  });
  if (response.status === 409) throw new SlackChannelConflict();
  if (!response.ok) throw new IntegrationRequestError(response.status);
  return channelSchema
    .pick({ agentId: true, replies: true, reactions: true, version: true })
    .parse(await readJson(response));
}

const emojiSchema = z.object({
  standard: z.array(z.string()),
  custom: z.array(z.object({ name: z.string(), url: z.url() })),
  missingScopes: z.array(z.string()),
});
export type SlackEmoji = z.infer<typeof emojiSchema>;

export async function loadSlackEmoji(workspaceId: string, signal?: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/emoji`, {
    signal: requestSignal(signal),
    cache: 'no-store',
  });
  if (!response.ok) throw new IntegrationRequestError(response.status);
  return emojiSchema.parse(await readJson(response));
}
