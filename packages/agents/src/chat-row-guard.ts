import type { HumanActor } from '@tulipfarm/access';
import { withHuman } from './saved-policy.ts';
import { relation, type AgentStorage } from './store.ts';
import { directChatRowLimit, rowsAlreadyWrittenSchema, type rowReviewReasonSchema } from './draft-contracts.ts';
import type { z } from 'zod';
import { namesTable } from './chat-table-lookup.ts';

type RowReviewReason = z.infer<typeof rowReviewReasonSchema>;
type RowsAlreadyWritten = z.infer<typeof rowsAlreadyWrittenSchema>;
export { directChatRowLimit, namesTable };

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
      } else if (write.tool === 'rows.update.batch') {
        rows += Array.isArray(result.records) ? result.records.length : 0;
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
  /** Rows already written directly in this chat; the card holds only the rest. */
  written?: RowsAlreadyWritten;
};
/** Nothing is written and no card is made: the model must stop or change its call. */
export type ChatRowRefusal = {
  error: 'approval-pending' | 'batch-required';
  table: string;
  instruction: string;
  /** The undecided card this change waits behind, for `approval-pending`. */
  waitingDraftId?: string;
  /** What that waiting card changes, so a reply names it rather than the refused rows. */
  waitingCard?: WaitingCardChange;
  /** Short summaries of the rows this refused call asked for, which are on no card. */
  notAdded?: string[];
};

/** A waiting row card's change: its tool, how many rows it touches, a few of their values, and a phrase for it. */
export type WaitingCardChange = { tool: string; rows: number; sample: string[]; summary: string };

const shownValue = (value: unknown) => {
  const typed = record(value);
  return ['text', 'numeric', 'date', 'timestamp'].includes(String(typed.kind)) && typeof typed.value === 'string'
    ? typed.value.trim().slice(0, 40)
    : typed.kind === 'boolean' && typeof typed.value === 'boolean'
      ? String(typed.value)
      : '';
};
/** A row's plain values joined, such as "Lime 10", in the order the call sent them. */
export function rowSummaries(rows: readonly unknown[], limit = 5) {
  return rows
    .slice(0, limit)
    .map(row =>
      Object.values(fieldValues(record(row).values))
        .map(shownValue)
        .filter(Boolean)
        .join(' ')
        .slice(0, 80),
    )
    .filter(Boolean);
}

/** The change a waiting row card holds, read from its saved call. */
export function waitingCardChange(input: unknown): WaitingCardChange {
  const call = record(input);
  const tool = typeof call.tool === 'string' ? call.tool : 'rows.create';
  const sent =
    (tool === 'rows.create.batch' || tool === 'rows.update.batch') && Array.isArray(call.rows)
      ? call.rows
      : [{ values: call.values }];
  const rows = Math.max(1, sent.length);
  const sample = rowSummaries(sent, 3);
  const listed = sample.length ? ` (${sample.join(', ')}${rows > sample.length ? ', …' : ''})` : '';
  const noun = `${rows} ${rows === 1 ? 'row' : 'rows'}`;
  const summary =
    tool === 'rows.update' || tool === 'rows.update.batch'
      ? `change ${noun}${listed} in`
      : tool === 'rows.delete'
        ? 'delete 1 row from'
        : `add ${noun}${listed} to`;
  return { tool, rows, sample, summary };
}

/**
 * Chat writes rows directly only when the person named the table and the reply writes at most five rows.
 * Larger writes, writes to an unnamed table and writes in a reply that prepares a table change need an
 * approval card. Models otherwise write into a similarly named table or add rows to "fix" a field conversion.
 *
 * The table's direct-write budget spans replies until a row review is decided or its revision changes.
 * The per-reply limit still applies across tables. Single-row creates in one reply must be one batch.
 */
export async function chatRowReview(
  runtime: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  origin: { conversationId: string; turnId: string },
  callId: string,
  call: { tool: string; tableId: string; expectedAppliedRevision: string; rows?: readonly unknown[]; values?: unknown },
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
      await tx.client.query<{ id: string; input: unknown }>(
        `SELECT d.id,d.proposal->'input' AS input FROM ${relation(tx, 'tf_chat_authoring_drafts')} d WHERE d.conversation_id=$1 AND d.id<>$2 AND d.proposal->>'kind'='row' AND d.proposal->'input'->>'tableId'=$3 AND d.proposal->'input'->>'expectedAppliedRevision'=$4
          AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_chat_authoring_decisions')} c WHERE c.draft_id=d.id) ORDER BY d.created_at DESC LIMIT 1`,
        [origin.conversationId, callId, call.tableId, call.expectedAppliedRevision],
      )
    ).rows[0];
    if (waiting) {
      const card = waitingCardChange(waiting.input);
      const onCard = new Set(
        rowSummaries(
          card.tool === 'rows.create.batch' || card.tool === 'rows.update.batch'
            ? (record(waiting.input).rows as unknown[])
            : [record(waiting.input)],
        ),
      );
      const sent =
        call.tool === 'rows.create' ? rowSummaries([{ values: call.values }]) : rowSummaries(call.rows ?? []);
      const asked = sent.filter(row => !onCard.has(row));
      if (sent.length && !asked.length)
        return {
          error: 'approval-pending',
          table: label,
          waitingDraftId: waiting.id,
          waitingCard: card,
          instruction: `Nothing from this call was written: these rows are already on the card earlier in this chat that is still waiting to ${card.summary} "${label}", and the chat shows the person a link to it. Tell the person plainly that this card is still waiting and that they can approve or dismiss it. Never say anything was denied, failed or not allowed, and do not draft or write these rows again in this reply.`,
        };
      return {
        error: 'approval-pending',
        table: label,
        waitingDraftId: waiting.id,
        waitingCard: card,
        ...(asked.length && { notAdded: asked }),
        instruction: `Nothing from this call was written, and it is on no card. A card earlier in this chat is still waiting to ${card.summary} "${label}", and the chat shows the person a link to it. That card holds only that change, not the rows or changes from this call. Tell the person plainly: nothing new was added; the waiting card is the one to ${card.summary} "${label}"; approve or dismiss it, then ask again for ${asked.length ? asked.join(', ') : 'this change'}. Never say the waiting card holds this call's rows, never add their counts together, never say anything was denied, failed or not allowed, and do not draft or write these rows again in this reply.`,
      };
    }
    if (proposing) return { ...changing, table: label };
    if (!namesTable(texts, label))
      return {
        reason: 'table-not-named',
        table: label,
        instruction: `The person never named the table "${label}", so this change needs approval on the chat card. Write rows only to the table they named. If that table does not exist or is not ready yet, tell them and write nothing; never use a similar table instead.`,
      };
    const writes = (
      await tx.client.query<EarlierWrite & { turnId: string }>(
        `SELECT c.tool,c.turn_id AS "turnId",s.call,s.output,EXISTS (SELECT 1 FROM ${relation(tx, 'tf_chat_authoring_drafts')} d WHERE d.id=c.id) AS drafted
            FROM ${relation(tx, 'tf_conversation_tool_calls')} c JOIN ${relation(tx, 'tf_conversation_execution_steps')} s ON s.call_id=c.id AND s.turn_id=c.turn_id
            WHERE c.conversation_id=$1 AND c.id<>$3 AND c.tool IN ('rows.create','rows.create.batch','rows.update','rows.update.batch','rows.delete')
            AND (c.turn_id=$2 OR (s.call->>'tableId'=$4 AND s.call->>'expectedAppliedRevision'=$5
              AND c.created_at > COALESCE((
                SELECT max(decision.created_at) FROM ${relation(tx, 'tf_chat_authoring_drafts')} draft
                JOIN ${relation(tx, 'tf_chat_authoring_decisions')} decision ON decision.draft_id=draft.id
                WHERE draft.conversation_id=$1 AND draft.proposal->>'kind'='row' AND draft.proposal->'input'->>'tableId'=$4
                  AND decision.outcome->>'kind' IN ('row','dismissed','rejected')
              ),'-infinity'::timestamptz)))`,
        [origin.conversationId, origin.turnId, callId, call.tableId, call.expectedAppliedRevision],
      )
    ).rows;
    const earlier = earlierRowWrites(
      writes.filter(write => write.turnId === origin.turnId),
      call.tableId,
    );
    const tableWrites = earlierRowWrites(
      writes.filter(write => record(write.call).tableId === call.tableId),
      call.tableId,
    );
    const budget = tableWrites.rows > earlier.rows ? tableWrites : earlier;
    if (earlier.reviewing || tableWrites.reviewing || budget.rows + (call.rows?.length ?? 1) > directChatRowLimit)
      return {
        reason: 'too-many-rows',
        table: label,
        instruction: budget.rows
          ? `This chat already wrote ${budget.rows} ${budget.rows === 1 ? 'row' : 'rows'} directly within this write budget, which stay written. More than ${directChatRowLimit} rows need approval, including across continued replies to the same table. The card holds only the rows in this call and tells the person which rows were already added. In your reply, say which rows were already added and that the rest wait on the card.`
          : `This reply changes more than ${directChatRowLimit} rows, so the change needs the person's approval on one chat card.`,
        ...(budget.rows > 0 && { written: alreadyWritten(budget) }),
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
