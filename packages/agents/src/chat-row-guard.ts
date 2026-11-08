import type { HumanActor } from '@tulipfarm/access';
import { withHuman } from './saved-policy.ts';
import { relation, type AgentStorage } from './store.ts';

/** The most rows one chat reply may write without an approval card. */
export const directChatRowLimit = 5;

const words = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Whether a table title appears in the chat, ignoring case, punctuation and a plural "s". */
export function namesTable(texts: readonly string[], label: string) {
  const name = words(label);
  if (!name) return false;
  const names = name.endsWith('s') && name.length > 1 ? [name, name.slice(0, -1).trimEnd()] : [name];
  return texts.some(text => {
    const padded = ` ${words(text)} `;
    return names.some(candidate => padded.includes(` ${candidate} `) || padded.includes(` ${candidate}s `));
  });
}

type EarlierWrite = { tool: string; call: unknown; output: unknown; drafted: boolean };
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** Rows this reply's earlier calls wrote directly, and whether any of them already went to review. */
export function earlierRowWrites(writes: readonly EarlierWrite[]) {
  let rows = 0,
    reviewing = false;
  for (const write of writes) {
    const result = record(record(write.output).result);
    if (write.drafted || result.error === 'review-required' || 'draftId' in result) reviewing = true;
    else if (!('error' in result) && write.output != null)
      rows += write.tool === 'rows.create.batch' ? (Array.isArray(result.records) ? result.records.length : 0) : 1;
  }
  return { rows, reviewing };
}

export type ChatRowReview = {
  reason: 'table-change-pending' | 'table-not-named' | 'too-many-rows';
  table?: string;
  instruction: string;
};

/**
 * Chat writes rows directly only when the person named the table and the reply writes at most five rows.
 * Larger writes, writes to an unnamed table and writes in a reply that prepares a table change need an
 * approval card. Models otherwise write into a similarly named table or add rows to "fix" a field conversion.
 */
export async function chatRowReview(
  runtime: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  origin: { conversationId: string; turnId: string },
  callId: string,
  call: { tool: string; tableId: string; rows?: readonly unknown[] },
): Promise<ChatRowReview | null> {
  return withHuman(runtime, workspaceId, actor, 'read', async tx => {
    const proposing = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_conversation_tool_calls')} WHERE conversation_id=$1 AND turn_id=$2 AND tool='tables.propose' LIMIT 1`,
        [origin.conversationId, origin.turnId],
      )
    ).rowCount;
    if (proposing)
      return {
        reason: 'table-change-pending',
        instruction:
          'This reply prepared a table change, so row changes need approval on the chat card. A field change never needs new or changed rows: if values block it, show the blocked report and ask the person how to fix them instead.',
      };
    const label = (
      await tx.client.query<{ label: string | null }>(
        `SELECT definition->>'label' AS label FROM ${relation(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
        [call.tableId],
      )
    ).rows[0]?.label;
    // Unknown or unreadable tables fail in the row tool itself.
    if (!label) return null;
    const texts = (
      await tx.client.query<{ text: string }>(
        `SELECT p.text FROM ${relation(tx, 'tf_conversation_parts')} p JOIN ${relation(tx, 'tf_conversation_messages')} m ON m.id=p.message_id AND m.conversation_id=p.conversation_id WHERE p.conversation_id=$1 AND m.author_kind='human'`,
        [origin.conversationId],
      )
    ).rows.map(row => row.text);
    if (!namesTable(texts, label))
      return {
        reason: 'table-not-named',
        table: label,
        instruction: `The person never named the table "${label}", so this change needs approval on the chat card. Write rows only to the table they named. If that table does not exist or is not ready yet, tell them and write nothing; never use a similar table instead.`,
      };
    const earlier = earlierRowWrites(
      (
        await tx.client.query<EarlierWrite>(
          `SELECT c.tool,s.call,s.output,EXISTS (SELECT 1 FROM ${relation(tx, 'tf_chat_authoring_drafts')} d WHERE d.id=c.id) AS drafted
            FROM ${relation(tx, 'tf_conversation_tool_calls')} c JOIN ${relation(tx, 'tf_conversation_execution_steps')} s ON s.call_id=c.id AND s.turn_id=c.turn_id
            WHERE c.conversation_id=$1 AND c.turn_id=$2 AND c.id<>$3 AND c.tool IN ('rows.create','rows.create.batch','rows.update','rows.delete')`,
          [origin.conversationId, origin.turnId, callId],
        )
      ).rows,
    );
    if (earlier.reviewing || earlier.rows + (call.rows?.length ?? 1) > directChatRowLimit)
      return {
        reason: 'too-many-rows',
        table: label,
        instruction: `This reply changes more than ${directChatRowLimit} rows, so each change needs approval on the chat card.`,
      };
    return null;
  });
}
