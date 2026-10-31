import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { messageSchema } from './contracts.ts';
import { matchesSlackSnapshot } from './message-content.ts';

export async function currentSlackMessage(tx: AuthorizationTransaction, eventId: string) {
  const row = z
    .object({ payload: messageSchema, changed: z.boolean(), message: z.unknown() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT e.payload,c.installation_id IS NOT NULL AS changed,c.message FROM ${qualified(tx.schema, 'tf_slack_events')} e
    LEFT JOIN ${qualified(tx.schema, 'tf_slack_message_changes')} c ON c.installation_id=e.installation_id AND c.generation=e.generation AND c.channel=e.payload->>'channel' AND c.message_ts=e.payload->>'ts'
    WHERE e.id=$1 AND e.disposition='held'`,
          [eventId],
        )
      ).rows[0],
    );
  if (!row || (row.changed && row.message === null)) throw new AccessDenied();
  const message = messageSchema.parse(row.changed ? row.message : row.payload);
  if (
    message.user !== row.payload.user ||
    message.channel !== row.payload.channel ||
    message.ts !== row.payload.ts ||
    (message.thread_ts ?? message.ts) !== (row.payload.thread_ts ?? row.payload.ts)
  )
    throw new AccessDenied();
  return message;
}

export function sameSlackMessage(left: z.infer<typeof messageSchema>, right: z.infer<typeof messageSchema>) {
  return (
    matchesSlackSnapshot(left, right) &&
    left.channel === right.channel &&
    (left.thread_ts ?? left.ts) === (right.thread_ts ?? right.ts)
  );
}

/** Marks a held request made by reacting to a message: the request's user reacted to `itemTs` with `reaction`. */
export const slackReactionRequestSchema = z.strictObject({
  reaction: z.string().regex(/^[a-z0-9_+'-]{1,100}(::skin-tone-[2-6])?$/),
  prompt: z.string().min(1).max(2000),
  itemTs: z.string().regex(/^\d{1,16}\.\d{6}$/),
});
export type SlackReactionRequest = z.infer<typeof slackReactionRequestSchema>;

export async function slackReactionRequest(tx: AuthorizationTransaction, eventId: string) {
  const value = (
    await tx.client.query(
      `SELECT payload->'tf_reaction' AS reaction FROM ${qualified(tx.schema, 'tf_slack_events')} WHERE id=$1 AND disposition='held'`,
      [eventId],
    )
  ).rows[0]?.reaction;
  return value == null ? null : slackReactionRequestSchema.parse(value);
}

/**
 * Whether a request is still in the thread Slack returned. A message request must be there unchanged; a reaction
 * request needs its message there, still carrying that reaction from the requester.
 */
export function slackRequestInThread(
  thread: {
    messages: readonly Parameters<typeof matchesSlackSnapshot>[0][];
    reactions: readonly { ts: string; name: string; users: readonly string[] }[];
  },
  request: z.infer<typeof messageSchema>,
  reaction: SlackReactionRequest | null,
) {
  if (!reaction) return thread.messages.some(message => matchesSlackSnapshot(message, request));
  const base = reaction.reaction.split('::')[0];
  return (
    thread.messages.some(message => message?.ts === reaction.itemTs) &&
    thread.reactions.some(
      item =>
        item.ts === reaction.itemTs &&
        (item.name === reaction.reaction || item.name.split('::')[0] === base) &&
        item.users.includes(request.user),
    )
  );
}

/** The request a reaction makes: the workspace's prompt for that reaction, applied to the reacted message. */
export function slackReactionPrompt(reaction: SlackReactionRequest) {
  return `The requester reacted with :${reaction.reaction}: to the message with ts ${reaction.itemTs} in this thread. This channel's instruction for that reaction comes from the workspace, not from Slack text.\nCurrent request: ${reaction.prompt}`;
}
