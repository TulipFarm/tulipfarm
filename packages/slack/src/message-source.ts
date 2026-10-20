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
