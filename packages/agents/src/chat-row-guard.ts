import type { HumanActor } from '@tulipfarm/access';
import { withHuman } from './saved-policy.ts';
import { relation, type AgentStorage } from './store.ts';
import { directChatRowLimit, rowsAlreadyWrittenSchema, type rowReviewReasonSchema } from './draft-contracts.ts';
import type { z } from 'zod';

type RowReviewReason = z.infer<typeof rowReviewReasonSchema>;
type RowsAlreadyWritten = z.infer<typeof rowsAlreadyWrittenSchema>;
export { directChatRowLimit };

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

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fieldValues = (value: unknown) => {
  const values = record(value);
  return Object.keys(values).every(key => uuid.test(key)) ? values : {};
};

/**
 * Rows this reply's earlier calls wrote directly, whether any of them already went to review, whether one
 * created a single row directly, and the rows they created in `tableId` with the values the call sent.
 */
export function earlierRowWrites(writes: readonly EarlierWrite[], tableId?: string) {
  let rows = 0,
    reviewing = false,
    singleCreate = false;
  const created: { recordId: string; values: Record<string, unknown> }[] = [];
  for (const write of writes) {
    const result = record(record(write.output).result);
    if (write.drafted || result.error === 'review-required' || 'draftId' in result) reviewing = true;
    else if (!('error' in result) && write.output != null) {
      const call = record(write.call);
      const sameTable = tableId !== undefined && call.tableId === tableId;
      if (write.tool === 'rows.create.batch') {
        const records = Array.isArray(result.records) ? result.records.map(record) : [];
        rows += records.length;
        const sent = Array.isArray(call.rows) ? call.rows.map(record) : [];
        if (sameTable)
          records.forEach((row, index) => {
            if (typeof row.id === 'string')
              created.push({ recordId: row.id, values: fieldValues(sent[index]?.values) });
          });
      } else {
        rows += 1;
        if (write.tool === 'rows.create') {
          singleCreate = true;
          if (sameTable && typeof result.id === 'string')
            created.push({ recordId: result.id, values: fieldValues(call.values) });
        }
      }
    }
  }
  return { rows, reviewing, singleCreate, created };
}

function alreadyWritten({ rows, created }: ReturnType<typeof earlierRowWrites>): RowsAlreadyWritten {
  const count = Math.min(rows, directChatRowLimit);
  return (
    rowsAlreadyWrittenSchema.safeParse({ count, rows: created.slice(0, directChatRowLimit) }).data ?? {
      count,
      rows: [],
    }
  );
}

/** The row change goes to one approval card holding the whole call. */
export type ChatRowReview = {
  reason: RowReviewReason;
  table?: string;
  instruction: string;
  /** Rows this reply already wrote directly; they stay, and the card holds only the rest. */
  written?: RowsAlreadyWritten;
};
/** Nothing is written and no card is made: the model must stop or change its call. */
export type ChatRowRefusal = {
  error: 'approval-pending' | 'batch-required';
  table: string;
  instruction: string;
  /** The undecided card this change waits behind, for `approval-pending`. */
  waitingDraftId?: string;
};

/**
 * Chat writes rows directly only when the person named the table and the reply writes at most five rows.
 * Larger writes, writes to an unnamed table and writes in a reply that prepares a table change need an
 * approval card. Models otherwise write into a similarly named table or add rows to "fix" a field conversion.
 *
 * Models also split a large request into single-row calls, or retry it in the next reply, so the row limit
 * would only hold per call. A second single-row create in one reply must be one batch instead, and while a
 * row card for the table waits in this chat no other row change to that table is written or drafted.
 */
export async function chatRowReview(
  runtime: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  origin: { conversationId: string; turnId: string },
  callId: string,
  call: { tool: string; tableId: string; rows?: readonly unknown[] },
): Promise<ChatRowReview | ChatRowRefusal | null> {
  return withHuman(runtime, workspaceId, actor, 'read', async tx => {
    const label = (
      await tx.client.query<{ label: string | null }>(
        `SELECT definition->>'label' AS label FROM ${relation(tx, 'tf_table_generations')} WHERE table_id=$1 AND state='active'`,
        [call.tableId],
      )
    ).rows[0]?.label;
    const proposing = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_conversation_tool_calls')} WHERE conversation_id=$1 AND turn_id=$2 AND tool='tables.propose' LIMIT 1`,
        [origin.conversationId, origin.turnId],
      )
    ).rowCount;
    const changing = {
      reason: 'table-change-pending',
      instruction:
        'This reply prepared a table change, so row changes need approval on the chat card. A field change never needs new or changed rows: if values block it, show the blocked report and ask the person how to fix them instead.',
    } as const;
    // Unknown or unreadable tables fail in the row tool itself.
    if (!label) return proposing ? changing : null;
    const texts = (
      await tx.client.query<{ text: string }>(
        `SELECT p.text FROM ${relation(tx, 'tf_conversation_parts')} p JOIN ${relation(tx, 'tf_conversation_messages')} m ON m.id=p.message_id AND m.conversation_id=p.conversation_id WHERE p.conversation_id=$1 AND m.author_kind='human'`,
        [origin.conversationId],
      )
    ).rows.map(row => row.text);
    const waiting = (
      await tx.client.query<{ id: string }>(
        `SELECT d.id FROM ${relation(tx, 'tf_chat_authoring_drafts')} d WHERE d.conversation_id=$1 AND d.id<>$2 AND d.proposal->>'kind'='row' AND d.proposal->'input'->>'tableId'=$3
          AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_chat_authoring_decisions')} c WHERE c.draft_id=d.id) ORDER BY d.created_at DESC LIMIT 1`,
        [origin.conversationId, callId, call.tableId],
      )
    ).rows[0]?.id;
    if (waiting)
      return {
        error: 'approval-pending',
        table: label,
        waitingDraftId: waiting,
        instruction: `Nothing has been written and no new card was made. A row change for "${label}" is already waiting for approval on a card earlier in this chat, and the chat shows the person a link to it. Tell them that card is waiting and to approve or dismiss it first; do not draft or write these rows again.`,
      };
    if (proposing) return { ...changing, table: label };
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
      call.tableId,
    );
    if (earlier.reviewing || earlier.rows + (call.rows?.length ?? 1) > directChatRowLimit)
      return {
        reason: 'too-many-rows',
        table: label,
        instruction: earlier.rows
          ? `This reply already wrote ${earlier.rows} ${earlier.rows === 1 ? 'row' : 'rows'} directly, which stay written, and more than ${directChatRowLimit} rows in one reply need approval. The card holds only the rows in this call and tells the person which rows were already added. In your reply, say which rows were already added and that the rest wait on the card.`
          : `This reply changes more than ${directChatRowLimit} rows, so the change needs the person's approval on one chat card.`,
        ...(earlier.rows > 0 && { written: alreadyWritten(earlier) }),
      };
    if (call.tool === 'rows.create' && earlier.singleCreate)
      return {
        error: 'batch-required',
        table: label,
        instruction: `This row was not created. Several new rows go in one rows.create.batch call, never one rows.create call per row. Call rows.create.batch once with every remaining row the person asked for in "${label}". If those rows and the ones already added in this reply are more than ${directChatRowLimit}, it returns one approval card for the batch instead of writing.`,
      };
    return null;
  });
}
