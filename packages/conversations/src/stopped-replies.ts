import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { stoppedReplyVersion } from './event-publisher.ts';
import { mergeSources, sourceDependenciesSchema } from './results.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);

/** Splits reply text into parts that each fit the part size limit. */
export function replyParts(text: string) {
  const parts: string[] = [];
  let part = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 65536) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

const streamedSchema = z.object({
  generation: z.number().int(),
  epoch: z.number().int(),
  text: z.string(),
  sources: sourceDependenciesSchema,
});

/**
 * Saves the text a stopped reply attempt had already streamed as a partial assistant reply. Its result row links it to
 * the cancelled turn, which marks it as stopped. Narration of a tool call is already on that call's receipt, so it is
 * not saved again. Returns the saved message's ID, or null when nothing had streamed.
 */
export async function keepStoppedReply(
  tx: AuthorizationTransaction,
  conversationId: string,
  turn: { id: string; generation: number; epoch: number },
) {
  if (Number((tx as { commonVersion?: number }).commonVersion ?? 0) < stoppedReplyVersion) return null;
  const stored = (
    await tx.client.query(`SELECT streamed FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1`, [turn.id])
  ).rows[0]?.streamed;
  await tx.client.query(`UPDATE ${table(tx, 'tf_conversation_turns')} SET streamed=NULL WHERE id=$1`, [turn.id]);
  const streamed = streamedSchema.safeParse(stored).data;
  if (!streamed || streamed.generation !== turn.generation || streamed.epoch !== turn.epoch || !streamed.text.trim())
    return null;
  const narrated = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} WHERE turn_id=$1 AND strpos(narration, btrim($2)) > 0 LIMIT 1`,
    [turn.id, streamed.text],
  );
  if (narrated.rowCount) return null;
  const steps = z
    .array(z.object({ sources: sourceDependenciesSchema, output: sourceDependenciesSchema.nullable() }))
    .parse(
      (
        await tx.client.query(
          `SELECT sources, output->'sources' AS output FROM ${table(tx, 'tf_conversation_execution_steps')} WHERE turn_id=$1`,
          [turn.id],
        )
      ).rows,
    );
  const context = z
    .array(z.object({ sources: sourceDependenciesSchema }))
    .parse(
      (
        await tx.client.query(
          `SELECT sources FROM ${table(tx, 'tf_conversation_model_sources')} WHERE turn_id=$1 AND epoch=$2`,
          [turn.id, turn.epoch],
        )
      ).rows,
    );
  const sources = mergeSources([
    ...streamed.sources,
    ...steps.flatMap(step => [...step.sources, ...(step.output ?? [])]),
    ...context.flatMap(row => row.sources),
  ]);
  const messageId = randomUUID();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_conversation_messages')} (id, conversation_id, sequence, author_kind)
    SELECT $1, id, next_message_sequence, 'assistant' FROM ${table(tx, 'tf_conversations')} WHERE id=$2`,
    [messageId, conversationId],
  );
  let ordinal = 0;
  for (const text of replyParts(streamed.text))
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, text) VALUES ($1,$2,$3,'text',$4)`,
      [conversationId, messageId, ordinal++, text],
    );
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_conversation_results')} (conversation_id, turn_id, message_id, sources) VALUES ($1,$2,$3,$4)`,
    [conversationId, turn.id, messageId, JSON.stringify(sources)],
  );
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence = next_message_sequence + 1 WHERE id = $1`,
    [conversationId],
  );
  return messageId;
}
