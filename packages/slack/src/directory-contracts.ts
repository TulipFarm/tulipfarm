import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';

export const slackResolveSchema = z.strictObject({
  tool: z.literal('slack.resolve'),
  kind: z.enum(['channel', 'user']),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(value => value.replace(/^[#@]/, '').trim().length > 0),
});
export type SlackResolve = z.infer<typeof slackResolveSchema>;
// A denial the requester can fix in Slack; tools return its code and instruction to the model.
export abstract class SlackChannelAccessError extends AccessDenied {
  abstract readonly code: string;
  abstract readonly instruction: string;
}
export class SlackChannelMembershipError extends SlackChannelAccessError {
  readonly code = 'app-not-in-channel';
  readonly instruction = 'Add the TulipFarm app to this Slack channel, then try again. No message was sent.';
}
export class SlackRequesterChannelMembershipError extends SlackChannelAccessError {
  readonly code = 'requester-not-in-channel';
  readonly instruction =
    'You are not a member of this Slack channel, and TulipFarm posts only where the requester is a member. Join the channel in Slack, then try again. No message was sent.';
}
