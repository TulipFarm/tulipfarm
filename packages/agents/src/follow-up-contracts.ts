import { z } from 'zod';

/** One follow-up runs at least this long and at most this long after it is asked for. */
export const followUpMinimumMinutes = 1;
export const followUpMaximumMinutes = 24 * 60;
/** A follow-up turn may schedule the next one; a chain stops after this many or this long after its first request. */
export const followUpChainLimit = 12;
export const followUpChainHours = 24;
/** The ⏰ reaction reminds the person who reacted this long later. */
export const followUpReactionMinutes = 60;
export const followUpReaction = 'alarm_clock';
/** The Slack button that cancels a pending follow-up. */
export const slackFollowUpCancelAction = 'slack_follow_up_cancel';
export const slackFollowUpCancelValueSchema = z.strictObject({ workspaceId: z.uuid(), followUpId: z.uuid() });

export const followUpStatusSchema = z.enum(['pending', 'claimed', 'fired', 'cancelled', 'failed', 'skipped']);
export type FollowUpStatus = z.infer<typeof followUpStatusSchema>;

export const followUpViewSchema = z.object({
  id: z.uuid(),
  instruction: z.string(),
  dueAt: z.string(),
  createdAt: z.string(),
  timezone: z.string().nullable(),
  status: followUpStatusSchema,
  surface: z.enum(['chat', 'slack']),
  origin: z.enum(['chat', 'slack-mention', 'slack-reaction']),
  chainDepth: z.number().int().min(1),
  failureReason: z.string().nullable(),
});
export type FollowUpView = z.infer<typeof followUpViewSchema>;

/** Shown on a chat message that a fired follow-up sent, so it reads as scheduled work rather than a new message. */
export const firedFollowUpSchema = z.object({ id: z.uuid(), instruction: z.string(), requestedAt: z.string() });

export const scheduleFollowUpCallSchema = z.strictObject({
  tool: z.literal('followups.schedule'),
  instruction: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      'What to do when it is due, written as a standalone instruction for a later turn, e.g. "Post a short coding quote in #tech" or "Check whether workflow run X finished and report the result".',
    ),
  // The range is checked by followups.schedule so an out-of-range delay gets the same refusal as an out-of-range time.
  delayMinutes: z
    .number()
    .finite()
    .optional()
    .describe(`Minutes from now, ${followUpMinimumMinutes} to ${followUpMaximumMinutes}. Give this or at, not both.`),
  at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Exact due time as an ISO 8601 date-time with offset. Give this or delayMinutes, not both.'),
  timezone: z
    .string()
    .max(64)
    .optional()
    .describe('IANA time zone the person used, such as Europe/London, so the confirmation shows their local time.'),
});
export const listFollowUpsCallSchema = z.strictObject({ tool: z.literal('followups.list') });
export const cancelFollowUpCallSchema = z.strictObject({ tool: z.literal('followups.cancel'), followUpId: z.uuid() });
export type ScheduleFollowUpCall = z.infer<typeof scheduleFollowUpCallSchema>;
