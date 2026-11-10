import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canAccessTable, type HumanActor } from '@tulipfarm/access';
import { activeGeneration, GenerationError } from '@tulipfarm/tables/store';
import type { postBotMessage } from '@tulipfarm/slack';
import { authoringProposalSchema, draftDecisionSchema, type RowProposal } from './draft-contracts.ts';
import { relation, type AgentTransaction } from './store.ts';

type SlackBlock = NonNullable<Parameters<typeof postBotMessage>[0]['blocks']>[number];

export const slackRowDraftApprove = 'slack_row_draft_approve';
export const slackRowDraftDismiss = 'slack_row_draft_dismiss';
export const slackRowDraftValueSchema = z.strictObject({
  workspaceId: z.uuid(),
  chatId: z.uuid(),
  draftId: z.uuid(),
  digest: draftDecisionSchema.shape.digest,
});

// A Slack message holds at most 50 blocks; a few cards keep room for the answer above them.
const shownDrafts = 3,
  shownFields = 10;
const verbs = { create: 'Add', update: 'Update', delete: 'Delete' } as const;
const operation = ({ input }: RowProposal) =>
  input.tool === 'rows.create' || input.tool === 'rows.create.batch'
    ? 'create'
    : input.tool === 'rows.update' || input.tool === 'rows.update.batch'
      ? 'update'
      : 'delete';
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** Each button press of one draft repeats the same command, so a second press replays the first decision. */
export function slackRowDraftCommand(draftId: string, decision: 'save' | 'dismiss') {
  const hex = createHash('sha256').update(`slack-row-draft:${draftId}:${decision}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? '0', 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function formatValue(value: unknown, options: readonly { id: string; label: string }[]): string {
  const option = (id: unknown) => options.find(item => item.id === id)?.label ?? String(id);
  const list = (items: unknown) => (Array.isArray(items) && items.length ? items.map(String).join(', ') : 'None');
  if (value === null || typeof value !== 'object' || !('kind' in value)) return 'Not set';
  const cell = value as Record<string, unknown>;
  switch (cell.kind) {
    case 'boolean':
      return cell.value ? 'Yes' : 'No';
    case 'single-select':
      return option(cell.optionId);
    case 'multi-select':
      return Array.isArray(cell.optionIds) && cell.optionIds.length ? cell.optionIds.map(option).join(', ') : 'None';
    case 'relationship':
      return list(cell.recordIds);
    case 'file':
      return list(cell.fileIds);
    default:
      return typeof cell.value === 'string' ? cell.value : JSON.stringify(cell.value ?? null);
  }
}

/**
 * Review cards for the turn's undecided row drafts, shown under the Slack answer like the chat's row card. They show
 * proposed values and, for batch updates, the reviewed identifiers and before-values of the patched fields.
 * Unrelated current values stay out of shared threads.
 */
export async function slackRowDraftCards(
  tx: AgentTransaction,
  workspaceId: string,
  actor: HumanActor,
  conversationId: string,
  turnId: string,
): Promise<SlackBlock[]> {
  const drafts = z.array(z.object({ id: z.uuid(), digest: z.string(), proposal: authoringProposalSchema })).parse(
    (
      await tx.client.query(
        `SELECT d.id,d.digest,d.proposal FROM ${relation(tx, 'tf_chat_authoring_drafts')} d WHERE d.conversation_id=$1 AND d.turn_id=$2 AND d.membership_id=$3 AND d.user_id=$4 AND d.proposal->>'kind'='row'
          AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_chat_authoring_decisions')} c WHERE c.draft_id=d.id) ORDER BY d.created_at,d.id LIMIT ${shownDrafts + 1}`,
        [conversationId, turnId, actor.membershipId, actor.userId],
      )
    ).rows,
  );
  const blocks: SlackBlock[] = [];
  for (const draft of drafts.slice(0, shownDrafts)) {
    if (draft.proposal.kind !== 'row') continue;
    const proposal = draft.proposal,
      { input } = proposal,
      kind = operation(proposal);
    let table: {
      label: string;
      labelFieldIds: string[];
      fields: { id: string; label: string; options: { id: string; label: string }[] }[];
    } = {
      label: 'a table you cannot see',
      labelFieldIds: [],
      fields: [],
    };
    if (await canAccessTable(tx, actor, input.tableId, 'table.row.read'))
      try {
        const { definition } = await activeGeneration(tx, input.tableId);
        table = {
          label: definition.label,
          labelFieldIds:
            definition.uniqueKeys[0]?.fieldIds ??
            [(definition.fields.find(field => field.kind === 'text') ?? definition.fields[0])?.id].filter(
              id => id !== undefined,
            ),
          fields: definition.fields.map(field => ({
            id: field.id,
            label: field.label,
            options: 'options' in field ? field.options.map(item => ({ id: item.id, label: item.label })) : [],
          })),
        };
      } catch (error) {
        if (!(error instanceof GenerationError)) throw error;
      }
    const cell = (fieldId: string, value: unknown) => {
      const field = table.fields.find(item => item.id === fieldId);
      return { label: field?.label ?? fieldId, value: formatValue(value, field?.options ?? []) };
    };
    const values =
      input.tool === 'rows.create.batch' || input.tool === 'rows.update.batch'
        ? input.rows
        : Object.entries(input.tool === 'rows.delete' ? {} : input.values);
    const fields =
      input.tool === 'rows.create.batch' || input.tool === 'rows.update.batch'
        ? input.rows.slice(0, shownFields).map((row, index) => {
            const before =
              input.tool === 'rows.update.batch' && table.fields.length
                ? proposal.before?.[input.rows[index]!.recordId]
                : undefined;
            const label =
              before && table.labelFieldIds.some(id => before[id] != null)
                ? table.labelFieldIds.map(id => cell(id, before[id]).value).join(' · ')
                : `Row ${index + 1}`;
            return {
              type: 'plain_text' as const,
              text: clip(
                `${label}\n${Object.entries(row.values)
                  .map(([fieldId, value]) => {
                    const shown = cell(fieldId, value);
                    return `${shown.label}: ${shown.value}${input.tool === 'rows.update.batch' ? `\nBefore ${before ? cell(fieldId, before[fieldId]).value : 'value unavailable'}` : ''}`;
                  })
                  .join(', ')}`,
                500,
              ),
            };
          })
        : Object.entries(input.tool === 'rows.delete' ? {} : input.values)
            .slice(0, shownFields)
            .map(([fieldId, value]) => {
              const shown = cell(fieldId, value);
              return { type: 'plain_text' as const, text: `${clip(shown.label, 100)}\n${clip(shown.value, 500)}` };
            });
    const count = input.tool === 'rows.create.batch' || input.tool === 'rows.update.batch' ? input.rows.length : 1;
    const value = JSON.stringify({ workspaceId, chatId: conversationId, draftId: draft.id, digest: draft.digest });
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: clip(
            `Review row change: ${verbs[kind]} ${count === 1 ? 'a row' : `${count} rows`} in ${table.label}`,
            3000,
          ),
        },
      },
      ...(fields.length ? [{ type: 'section' as const, fields }] : []),
      {
        type: 'context',
        elements: [
          {
            type: 'plain_text',
            text: [
              input.tool === 'rows.create'
                ? 'Adds a new row.'
                : input.tool === 'rows.create.batch'
                  ? `Adds ${count} new rows together.`
                  : input.tool === 'rows.update.batch'
                    ? `Updates ${count} existing rows together.`
                    : `${verbs[kind]}s row ${input.recordId}.`,
              values.length > shownFields
                ? `${values.length - shownFields} more ${input.tool === 'rows.create.batch' || input.tool === 'rows.update.batch' ? 'rows are' : 'fields are'} set.`
                : '',
              proposal.written
                ? `${proposal.written.count === 1 ? '1 row was' : `${proposal.written.count} rows were`} already changed in this reply; those changes stay. This card holds only the rest.`
                : '',
              proposal.reason
                ? 'Chat writes only a few rows directly into a table you named, so this change waits for approval by the person who asked. Approving makes this exact change with their table access.'
                : 'This chat used content from outside your tables, so the change waits for approval by the person who asked. Approving makes this exact change with their table access.',
            ]
              .filter(Boolean)
              .join(' '),
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: slackRowDraftApprove,
            text: { type: 'plain_text', text: kind === 'delete' ? 'Approve deletion' : 'Approve change' },
            style: kind === 'delete' ? 'danger' : 'primary',
            value,
          },
          { type: 'button', action_id: slackRowDraftDismiss, text: { type: 'plain_text', text: 'Dismiss' }, value },
        ],
      },
    );
  }
  if (drafts.length > shownDrafts)
    blocks.push({
      type: 'context',
      elements: [{ type: 'plain_text', text: 'More row changes were drafted than fit here. Ask again for the rest.' }],
    });
  return blocks;
}
