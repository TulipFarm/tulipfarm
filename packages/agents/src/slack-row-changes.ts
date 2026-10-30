import { z } from 'zod';
import { canAccessTable, type HumanActor } from '@tulipfarm/access';
import { rowChangeForReceipt } from '@tulipfarm/conversations/row-view';
import type { TableDefinition, TableField, TableValue } from '@tulipfarm/tables/definition';
import { nameField, recordLabel } from '@tulipfarm/tables/query';
import { activeGeneration, GenerationError, readRecords, workspaceMembersTable } from '@tulipfarm/tables/store';
import type { postBotMessage } from '@tulipfarm/slack';
import { relation, type AgentTransaction } from './store.ts';

type SlackAttachment = NonNullable<Parameters<typeof postBotMessage>[0]['attachments']>[number];
type SlackBlock = SlackAttachment['blocks'][number];
/** Builds the web link to one row, or nothing when the workspace's address is unknown. */
export type SlackRowLink = (workspaceId: string, tableId: string, recordId: string) => Promise<string | undefined>;

const shownRows = 5,
  shownFields = 10,
  shownLinks = 5;
const accent = '#146c2f';
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const writeSchema = z.object({
  tool: z.enum(['rows.create', 'rows.create.batch', 'rows.update']),
  values: z.record(z.string(), z.unknown()).optional(),
  rows: z.array(z.object({ values: z.record(z.string(), z.unknown()) })).optional(),
});

type Written = { tableId: string; recordId: string; kind: 'created' | 'updated'; values: Record<string, unknown> };

/** Rows the turn's completed writes committed, in call order, with the values each write set. */
async function writtenRows(tx: AgentTransaction, conversationId: string, turnId: string) {
  const rows = z
    .array(z.object({ id: z.uuid(), tool: z.string(), status: z.string(), call: z.unknown(), output: z.unknown() }))
    .parse(
      (
        await tx.client.query(
          `SELECT c.id,c.tool,c.status,s.call,s.output FROM ${relation(tx, 'tf_conversation_tool_calls')} c JOIN ${relation(tx, 'tf_conversation_execution_steps')} s ON s.call_id=c.id AND s.turn_id=c.turn_id
            WHERE c.turn_id=$1 AND c.conversation_id=$2 AND c.status='completed' AND c.tool IN ('rows.create','rows.create.batch','rows.update')
            AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_chat_authoring_drafts')} d WHERE d.id=c.id)
            ORDER BY c.created_at,c.sequence,c.id`,
          [turnId, conversationId],
        )
      ).rows,
    );
  const written: Written[] = [];
  for (const row of rows) {
    const change = rowChangeForReceipt(row);
    const call = writeSchema.safeParse(row.call);
    if (!change || !call.success) continue;
    const values = call.data.tool === 'rows.create.batch' ? (call.data.rows ?? []).map(item => item.values) : [];
    change.recordIds.forEach((recordId, index) =>
      written.push({
        tableId: change.tableId,
        recordId,
        kind: change.kind,
        values: (call.data.tool === 'rows.create.batch' ? values[index] : call.data.values) ?? {},
      }),
    );
  }
  return written;
}

/** Labels the linked rows a write named, only from tables the requester can read. */
async function linkedLabels(tx: AgentTransaction, actor: HumanActor, field: TableField, ids: string[]) {
  if (field.kind !== 'relationship' || !ids.length) return new Map<string, string>();
  if (!(await canAccessTable(tx, actor, field.targetTableId, 'table.row.read'))) return new Map<string, string>();
  try {
    const target = await activeGeneration(tx, field.targetTableId);
    const systemKind =
      (await workspaceMembersTable(tx).catch(() => null))?.coreDefinition.id === target.table_id
        ? 'workspace-members'
        : undefined;
    const records = await readRecords(tx, target, { ids, limit: ids.length });
    return new Map(records.map(record => [record.id, recordLabel(target.definition, record.values, systemKind)]));
  } catch (error) {
    if (error instanceof GenerationError) return new Map<string, string>();
    throw error;
  }
}

async function formatValue(tx: AgentTransaction, actor: HumanActor, field: TableField, raw: unknown) {
  const parsed = z.object({ kind: z.string() }).passthrough().safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data as NonNullable<TableValue> & Record<string, unknown>;
  const option = (id: unknown) =>
    ('options' in field ? field.options.find(item => item.id === id)?.label : undefined) ?? undefined;
  switch (value.kind) {
    case 'boolean':
      return value.value ? 'Yes' : 'No';
    case 'single-select':
      return option(value.optionId);
    case 'multi-select': {
      const labels = z.array(z.string()).catch([]).parse(value.optionIds).map(option).filter(Boolean);
      return labels.length ? labels.join(', ') : undefined;
    }
    case 'relationship': {
      const ids = z.array(z.uuid()).catch([]).parse(value.recordIds);
      const labels = await linkedLabels(tx, actor, field, ids);
      const shown = ids.map(id => labels.get(id)).filter(Boolean);
      return shown.length ? shown.join(', ') : undefined;
    }
    case 'file': {
      const count = z.array(z.unknown()).catch([]).parse(value.fileIds).length;
      return count ? `${count} file${count === 1 ? '' : 's'}` : undefined;
    }
    default:
      return typeof value.value === 'string' && value.value.trim() ? value.value : undefined;
  }
}

/**
 * Cards for the rows this turn created or updated, shown under the Slack answer like a linked issue. They show only the
 * values the turn's own writes set, never the row's other current values, since the thread may be shared.
 */
export async function slackRowChangeCards(
  tx: AgentTransaction,
  workspaceId: string,
  actor: HumanActor,
  conversationId: string,
  turnId: string,
  link?: SlackRowLink,
): Promise<SlackAttachment[]> {
  const written = await writtenRows(tx, conversationId, turnId);
  const tables = new Map<string, TableDefinition | null>();
  const attachments: SlackAttachment[] = [];
  let links = 0;
  for (const row of written.slice(0, shownRows)) {
    if (!tables.has(row.tableId)) {
      let definition: TableDefinition | null = null;
      if (await canAccessTable(tx, actor, row.tableId, 'table.row.read'))
        try {
          definition = (await activeGeneration(tx, row.tableId)).definition;
        } catch (error) {
          if (!(error instanceof GenerationError)) throw error;
        }
      tables.set(row.tableId, definition);
    }
    const definition = tables.get(row.tableId);
    if (!definition) continue;
    const named = nameField(definition);
    const title = named ? await formatValue(tx, actor, named, row.values[named.id]) : undefined;
    const fields: { type: 'mrkdwn'; text: string }[] = [];
    for (const field of definition.fields) {
      if (fields.length >= shownFields) break;
      if (field.id === named?.id || !Object.hasOwn(row.values, field.id)) continue;
      const text = await formatValue(tx, actor, field, row.values[field.id]);
      if (text)
        fields.push({ type: 'mrkdwn', text: `*${escape(clip(field.label, 100))}*\n${escape(clip(text, 500))}` });
    }
    const url = link && links < shownLinks ? await link(workspaceId, row.tableId, row.recordId) : undefined;
    links += 1;
    const heading = escape(clip(title ?? (row.kind === 'created' ? 'New row' : 'Updated row'), 200));
    const blocks: SlackBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: url ? `*<${url}|${heading}>*` : `*${heading}*` } },
      ...(fields.length ? [{ type: 'section' as const, fields }] : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${escape(clip(definition.label, 200))}  |  ${row.kind === 'created' ? 'Created' : 'Updated'} <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|just now>`,
          },
        ],
      },
    ];
    attachments.push({ color: accent, fallback: clip(`${title ?? 'Row'} in ${definition.label}`, 300), blocks });
  }
  if (written.length > shownRows)
    attachments.push({
      color: accent,
      fallback: `${written.length - shownRows} more rows changed`,
      blocks: [
        {
          type: 'context',
          elements: [{ type: 'plain_text', text: `${written.length - shownRows} more rows were changed.` }],
        },
      ],
    });
  return attachments;
}
