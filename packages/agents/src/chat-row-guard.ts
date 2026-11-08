import type { HumanActor } from '@tulipfarm/access';
import { withHuman } from './saved-policy.ts';
import { relation, type AgentStorage } from './store.ts';

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

/**
 * A direct chat row write is refused, with nothing written, when the same reply is preparing a table change,
 * or when nobody in the chat named the target table. Models otherwise write into a similarly named table
 * or add rows to "fix" values that block a field conversion.
 */
export async function chatRowWriteRefusal(
  runtime: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  origin: { conversationId: string; turnId: string },
  tableId: string,
) {
  return withHuman(runtime, workspaceId, actor, 'read', async tx => {
    const proposing = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_conversation_tool_calls')} WHERE conversation_id=$1 AND turn_id=$2 AND tool='tables.propose' LIMIT 1`,
        [origin.conversationId, origin.turnId],
      )
    ).rowCount;
    if (proposing)
      return {
        error: 'table-change-pending',
        instruction:
          'No rows were changed. This reply prepared a table change for review, so it cannot also create, update or delete rows. If values block a field change, show the blocked report and ask the person how to fix them. Change rows only after they agree in a later message.',
      };
    const label = (
      await tx.client.query<{ label: string | null }>(
        `SELECT definition->>'label' AS label FROM ${relation(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
        [tableId],
      )
    ).rows[0]?.label;
    // Unknown or unreadable tables fail in the row tool itself.
    if (!label) return null;
    const texts = (
      await tx.client.query<{ text: string }>(
        `SELECT p.text FROM ${relation(tx, 'tf_conversation_parts')} p JOIN ${relation(tx, 'tf_conversation_messages')} m ON m.id=p.message_id AND m.conversation_id=p.conversation_id WHERE p.conversation_id=$1`,
        [origin.conversationId],
      )
    ).rows.map(row => row.text);
    if (namesTable(texts, label)) return null;
    return {
      error: 'table-not-named',
      table: label,
      instruction: `No rows were changed. Nobody in this chat named the table "${label}". Write rows only to the table the person named. If that table does not exist or is not ready yet, tell them and write nothing. If you think they mean "${label}", ask them to confirm it by name.`,
    };
  });
}
