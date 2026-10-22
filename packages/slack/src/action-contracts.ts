import { z } from 'zod';

const destination = { destinationId: z.uuid() };
const timestamp = z.string().regex(/^\d{1,16}\.\d{6}$/);
export const slackActionSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('slack.message.send'), ...destination, text: z.string().min(1).max(4000) }),
  z.strictObject({
    tool: z.literal('slack.thread.reply'),
    ...destination,
    threadTs: timestamp,
    text: z.string().min(1).max(4000),
  }),
  z.strictObject({
    tool: z.literal('slack.reaction.add'),
    ...destination,
    messageTs: timestamp,
    reaction: z.string().regex(/^[a-z0-9_+-]{1,64}$/),
  }),
]);
export type SlackAction = z.infer<typeof slackActionSchema>;
// 'user' posts through the requester's linked account; 'app' posts as the TulipFarm app.
export const slackSenderSchema = z.enum(['user', 'app']);
export type SlackSender = z.infer<typeof slackSenderSchema>;
export const slackActionStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'stale',
  'revoked',
  'sending',
  'sent',
  'retry',
  'reauthorization-required',
  'unknown',
]);
export const slackNotificationStatusSchema = z.enum(['sending', 'sent', 'retry', 'unknown', 'blocked']);
export const slackActionViewSchema = z.object({
  provider: z.literal('slack'),
  id: z.uuid(),
  runId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  action: slackActionSchema,
  channel: z.string(),
  status: slackActionStatusSchema,
  approvalRequired: z.boolean(),
  expiresAt: z.string(),
  nextAttemptAt: z.string(),
  sentMessageTs: timestamp.nullable().optional(),
  sender: slackSenderSchema.optional(),
  notificationStatus: slackNotificationStatusSchema.nullable().optional(),
});
export const slackDecisionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
});
export const slackDestinationViewSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  channel: z.string(),
  teamId: z.string(),
  installationId: z.uuid(),
});
