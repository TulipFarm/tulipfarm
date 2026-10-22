import { z } from 'zod';
import {
  AccessDenied,
  requireProtectedSource,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  calendarReadCallSchema,
  parseCalendarRead,
  calendarHistoryResultSchema,
  type CalendarHistoryResult,
} from '@tulipfarm/google-workspace/calendar-events';
import { conversationResultSchema } from './results.ts';

const outputSchema = z.object({
  result: z.object({
    error: z.never().optional(),
    provider: z.literal('google-workspace'),
    untrusted: z.literal(true),
    data: z.object({ error: z.never().optional(), untrusted: z.literal(true), data: z.unknown() }),
  }),
  sources: conversationResultSchema.shape.sources,
});
const rowSchema = z.object({
  call_id: z.uuid(),
  source_message_id: z.uuid(),
  created_at: z.date(),
  call: z.unknown(),
  sources: z.unknown(),
  output: z.unknown(),
});

export async function calendarResultsForHistory(
  tx: AuthorizationTransaction & { commonVersion: number },
  actor: HumanActor,
  conversationId: string,
  messageIds: string[],
) {
  const results = new Map<string, CalendarHistoryResult[]>();
  if (!messageIds.length) return results;
  const table = (name: string) => qualified(tx.schema, name);
  const rows = z.array(rowSchema).parse(
    (
      await tx.client.query(
        `SELECT s.call_id,s.call,s.sources,s.output,c.created_at,t.source_message_id
    FROM ${table('tf_conversation_execution_steps')} s JOIN ${table('tf_conversation_tool_calls')} c ON c.id=s.call_id
    JOIN ${table('tf_conversation_turns')} t ON t.id=s.turn_id
    WHERE t.conversation_id=$1 AND c.conversation_id=$1 AND t.source_message_id=ANY($2::uuid[])
    AND c.tool='google.read' AND c.status='completed' AND s.output IS NOT NULL ORDER BY c.sequence,c.id`,
        [conversationId, messageIds],
      )
    ).rows,
  );
  for (const row of rows) {
    const call = calendarReadCallSchema.safeParse(row.call);
    if (
      !call.success ||
      (call.data.operation.kind !== 'calendar.events.list' && call.data.operation.kind !== 'calendar.events.get')
    )
      continue;
    let result: CalendarHistoryResult = { kind: 'unavailable', callId: row.call_id };
    try {
      const output = outputSchema.parse(row.output);
      const retained = conversationResultSchema.shape.sources.parse(row.sources);
      if (
        !output.sources.some(
          source =>
            source.kind === 'google-integration' &&
            source.requiredScopes.includes('https://www.googleapis.com/auth/calendar'),
        )
      )
        throw new AccessDenied();
      for (const source of [...retained, ...output.sources]) await requireProtectedSource(tx, actor, source);
      const page = parseCalendarRead(call.data.operation, output.result.data.data);
      result = calendarHistoryResultSchema.parse({
        kind: 'events',
        callId: row.call_id,
        requestedAt: row.created_at.toISOString(),
        events: page.events,
        continuation: page.nextPageToken ? 'more-available' : 'complete',
      });
    } catch (error) {
      if (
        !(error instanceof AccessDenied) &&
        !(error instanceof z.ZodError) &&
        !(
          error instanceof Error &&
          ['Invalid calendar response', 'Calendar event identity changed'].includes(error.message)
        )
      )
        throw error;
    }
    const entries = results.get(row.source_message_id) ?? [];
    entries.push(result);
    results.set(row.source_message_id, entries);
  }
  return results;
}
