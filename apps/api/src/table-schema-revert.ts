import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessTable,
  lockAuthorization,
  requireTablePermission,
  resolveHuman,
  type HumanActor,
} from '@tulipfarm/access';
import { recordConversationActivity } from '@tulipfarm/conversations/activity';
import { notifyConversationChange } from '@tulipfarm/conversations/event-publisher';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { definitionSchema, valuesSchema, type TableValue } from '@tulipfarm/tables/definition';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import {
  blockedTableProposalSchema,
  proposalManifestSchema,
  TableProposalError,
  TableProposalValidationError,
} from '@tulipfarm/tables/proposal-contracts';
import { createTableProposals, type TableProposalOptions } from '@tulipfarm/tables/proposals';
import { schemaRevertBuilder, type SchemaRevert } from '@tulipfarm/tables/schema-revert';
import { generationProposalData, workspaceMembersTable } from '@tulipfarm/tables/store';

type Transaction = Parameters<TableProposalOptions['requireSources']>[0];

/** Why a revert cannot be proposed now. */
export class SchemaRevertError extends Error {
  readonly code = 'revert-unavailable';
  constructor() {
    super('revert-unavailable');
  }
}

export const schemaRevertResultSchema = z.object({ chatId: z.uuid() });
const responder = 'schema-revert-v1';

/** A stable UUID for one part of a revert request, so retrying the same chat id repeats the same writes. */
function derivedId(chatId: string, part: string) {
  const hex = createHash('sha256').update(`${chatId}:${part}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const latestSchema = z
  .object({
    id: z.uuid(),
    revision: z.string(),
    generation_id: z.uuid(),
    manifest: z.unknown(),
    active_revision: z.string().nullable(),
  })
  .optional();

/**
 * Who may revert which schema change. Only the newest completed change of an active table can be reverted, while the
 * table still has the revision that change produced.
 */
async function revertable(tx: Transaction, actor: HumanActor, tableId: string) {
  if (
    (
      await tx.client.query(`SELECT 1 FROM "${tx.schema}".tf_table_catalog WHERE id=$1 AND archived_at IS NOT NULL`, [
        tableId,
      ])
    ).rowCount ||
    tableId === (await workspaceMembersTable(tx))?.coreDefinition.id ||
    !(await canAccessTable(tx, actor, tableId, 'table.schema.manage'))
  )
    return { manages: false, latestId: null, latest: null } as const;
  const s = `"${tx.schema}"`;
  const latest = latestSchema.parse(
    (
      await tx.client.query(
        `SELECT e.id,e.revision,g.id AS generation_id,p.manifest,
          (SELECT revision FROM ${s}.tf_table_generations WHERE table_id=e.table_id AND state='active') AS active_revision
        FROM ${s}.tf_table_executions e JOIN ${s}.tf_table_proposals p ON p.id=e.proposal_id
        JOIN ${s}.tf_table_generations g ON g.table_id=e.table_id AND g.revision=e.revision AND g.activated_at IS NOT NULL
        WHERE e.table_id=$1 AND e.phase='completed'
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.manifest->'plans') plan WHERE plan->'input'->>'tableId'=e.table_id::text AND plan->'input'->>'kind'='schema')
        ORDER BY g.activated_at DESC,e.id DESC LIMIT 1`,
        [tableId],
      )
    ).rows[0],
  );
  if (!latest) return { manages: true, latestId: null, latest: null } as const;
  if (latest.active_revision !== latest.revision) return { manages: true, latestId: latest.id, latest: null } as const;
  const manifest = proposalManifestSchema.safeParse(latest.manifest);
  const plan = manifest.success ? manifest.data.plans.find(item => item.input.tableId === tableId) : undefined;
  if (!plan?.before || plan.input.kind !== 'schema')
    return { manages: true, latestId: latest.id, latest: null } as const;
  return {
    manages: true,
    latestId: latest.id,
    latest: {
      id: latest.id,
      revision: latest.revision,
      generationId: latest.generation_id,
      before: plan.before,
      after: plan.after,
      recomputed: plan.input.transforms.outputs.map(output => output.fieldId),
    },
  } as const;
}

/** Revert actions and links for Schema history entries. */
export async function schemaRevertLinks(tx: Transaction, actor: HumanActor, tableId: string) {
  const { manages, latestId, latest } = await revertable(tx, actor, tableId);
  const s = `"${tx.schema}"`;
  // A completed change reverts an earlier one when it swaps that change's definitions back.
  const changes = z.array(z.object({ id: z.uuid(), reverts: z.uuid().nullable() })).parse(
    (
      await tx.client.query(
        `WITH changes AS (
          SELECT e.id,g.activated_at,plan->'before' AS before,plan->'after' AS after
          FROM ${s}.tf_table_executions e JOIN ${s}.tf_table_proposals p ON p.id=e.proposal_id
          JOIN ${s}.tf_table_generations g ON g.table_id=e.table_id AND g.revision=e.revision AND g.activated_at IS NOT NULL
          CROSS JOIN LATERAL jsonb_array_elements(p.manifest->'plans') plan
          WHERE e.table_id=$1 AND e.phase='completed' AND plan->'input'->>'tableId'=e.table_id::text AND plan->'input'->>'kind'='schema'
            AND jsonb_typeof(plan->'before')='object'
        )
        SELECT c.id,(SELECT o.id FROM changes o WHERE o.activated_at<c.activated_at AND o.after=c.before AND o.before=c.after
          ORDER BY o.activated_at DESC,o.id DESC LIMIT 1) AS reverts
        FROM changes c`,
        [tableId],
      )
    ).rows,
  );
  const links = new Map(changes.map(row => [row.id, row.reverts]));
  return {
    /** `available` for the change that can be reverted now, `later-changes` for older changes. */
    revert(id: string) {
      if (!manages || !links.has(id)) return null;
      if (id === latestId) return latest ? ('available' as const) : null;
      return 'later-changes' as const;
    },
    /** The earlier change this one reverted. */
    reverts(id: string) {
      return links.get(id) ?? null;
    },
  };
}

const retainedSchema = z.object({
  row_id: z.uuid(),
  field_ids: z.array(z.uuid()),
  before_values: valuesSchema,
  values: valuesSchema,
  written: z.array(z.uuid()),
  replaced: z.boolean(),
});

/** Builds the revert from the recorded definitions and the values the change replaced. */
async function prepare(
  tx: Transaction,
  actor: HumanActor,
  tableId: string,
  executionId: string,
  options: TableProposalOptions,
) {
  const { latest } = await revertable(tx, actor, tableId);
  if (!latest || latest.id !== executionId) throw new SchemaRevertError();
  const builder = schemaRevertBuilder(latest);
  const fields = new Set<string>(builder.fieldIds);
  const s = `"${tx.schema}"`;
  /** Per row, each replaced field's value before the change and the value the change wrote. */
  const retained = new Map<string, Map<string, { before: TableValue; after: TableValue }>>();
  if (fields.size)
    for (const row of z.array(retainedSchema).parse(
      (
        await tx.client.query(
          `SELECT h.row_id,h.field_ids,h.before_values,h.values,
            COALESCE((SELECT array_agg(DISTINCT f) FROM ${s}.tf_table_row_history l CROSS JOIN LATERAL unnest(l.field_ids) f
              WHERE l.table_id=h.table_id AND l.row_id=h.row_id AND l.created_at>h.created_at AND l.operation<>'transform'),'{}') AS written,
            EXISTS(SELECT 1 FROM ${s}.tf_table_row_history l WHERE l.table_id=h.table_id AND l.row_id=h.row_id
              AND l.created_at>h.created_at AND l.operation IN ('delete','restore')) AS replaced
          FROM ${s}.tf_table_row_history h
          WHERE h.generation_id=$1 AND h.operation='transform' AND h.recoverable_until>clock_timestamp()
            AND h.before_values IS NOT NULL AND h.values IS NOT NULL`,
          [latest.generationId],
        )
      ).rows,
    )) {
      if (row.replaced) continue;
      const before: Record<string, TableValue> = row.before_values;
      const after: Record<string, TableValue> = row.values;
      const kept = new Map(
        row.field_ids
          .filter(id => fields.has(id) && !row.written.includes(id))
          .map(id => [id, { before: before[id] ?? null, after: after[id] ?? null }] as const),
      );
      if (kept.size) retained.set(row.row_id, kept);
    }
  const data = options.data ?? generationProposalData;
  for (let cursor: string | null = null; ;) {
    const page = await data.records(tx, tableId, cursor);
    for (const row of page) {
      const current: Record<string, TableValue> = row.values;
      // A value written after the change stays current, even when it was later set back.
      const unchanged = [...(retained.get(row.id) ?? [])].filter(
        ([id, value]) => canonicalJson(current[id] ?? null) === canonicalJson(value.after),
      );
      builder.add(
        row.values,
        unchanged.length ? Object.fromEntries(unchanged.map(([id, value]) => [id, value.before])) : undefined,
      );
    }
    if (page.length < 1000) break;
    cursor = page.at(-1)?.id ?? null;
  }
  return builder.finish(latest.revision);
}

function rows(count: number, singular: string, plural: string) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? `row ${singular}` : `rows ${plural}`}`;
}

/** The reply that explains the generated revert before the person reviews it. */
export function schemaRevertSummary(label: string, revert: SchemaRevert) {
  const lines = [
    `This proposal reverts the latest schema change to ${label}. It returns the table to the fields it had before that change. Nothing changes until you approve it.`,
  ];
  const details = [
    ...revert.fields.map(field =>
      field.restored
        ? `${field.label}: ${rows(field.restored, 'gets back its value', 'get back their values')} from before the change; ${rows(field.kept, 'keeps its current value', 'keep their current values')}.`
        : `${field.label}: every row keeps its current value.`,
    ),
    ...revert.returned.map(field => `${field.label} comes back without values.`),
    ...revert.removed.map(field => `${field.label} is removed with its values.`),
  ];
  if (details.length) lines.push('', ...details.map(line => `- ${line}`));
  return lines.join('\n');
}

const unavailable = 'The revert could not be prepared. Open Schema history and try again.';
const failures: Readonly<Record<string, string>> = {
  'proposal-stale':
    'The table changed while the revert was being prepared. Open Schema history and propose the revert again.',
  'table-archived': 'The table was archived, so its schema cannot be reverted.',
};

export function createTableSchemaRevert(options: TableProposalOptions) {
  const proposals = createTableProposals(options);
  return {
    /**
     * Opens a private chat holding a reviewed revert of the table's latest completed schema change.
     * Retrying with the same chat id returns the same chat.
     */
    async propose(workspaceId: string, userId: string, tableId: string, executionId: string, chatId: string) {
      const ids = {
        message: derivedId(chatId, 'message'),
        turn: derivedId(chatId, 'turn'),
        response: derivedId(chatId, 'response'),
        proposal: derivedId(chatId, 'proposal'),
      };
      const started = await options.runtime.transaction(workspaceId, executionCompatibility, async tx => {
        await lockAuthorization(tx);
        const actor = await resolveHuman(tx, userId);
        await requireTablePermission(tx, actor, tableId, 'table.row.read');
        const existing = z
          .object({ owned: z.boolean(), status: z.string().nullable() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT (c.owner_user_id=$2 AND c.owner_membership_id=$3 AND c.kind='private' AND c.deleted_at IS NULL) AS owned,
                  (SELECT t.status FROM "${tx.schema}".tf_conversation_turns t WHERE t.id=$4 AND t.conversation_id=c.id AND t.responder='${responder}') AS status
                FROM "${tx.schema}".tf_conversations c WHERE c.id=$1`,
                [chatId, actor.userId, actor.membershipId, ids.turn],
              )
            ).rows[0],
          );
        if (existing) {
          if (!existing.owned || !existing.status) throw new AccessDenied();
          if (existing.status === 'completed') return { actor, revert: null, done: true };
          // An earlier attempt stopped before the proposal was stored; propose returns it unchanged if it was.
          const revert = await prepare(tx, actor, tableId, executionId, options).catch((error: unknown) => {
            if (error instanceof SchemaRevertError) return null;
            throw error;
          });
          return { actor, revert, done: false };
        }
        const revert = await prepare(tx, actor, tableId, executionId, options);
        const label = definitionSchema.shape.label.parse(revert.plan.target.label);
        const s = `"${tx.schema}"`;
        await tx.client.query(
          `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id,title,title_manual,next_message_sequence) VALUES($1,$2,$3,$4,true,3)`,
          [chatId, actor.userId, actor.membershipId, `Revert ${label} schema change`.slice(0, 120)],
        );
        await tx.client.query(
          `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
          [ids.message, chatId, actor.membershipId],
        );
        await tx.client.query(
          `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,text) VALUES($1,$2,0,'text',$3)`,
          [chatId, ids.message, `Propose reverting the latest schema change to ${label}.`],
        );
        await tx.client.query(
          `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence,responder) VALUES($1,$2,$3,1,$4)`,
          [ids.turn, chatId, ids.message, responder],
        );
        await tx.client.query(
          `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind) VALUES($1,$2,2,'assistant')`,
          [ids.response, chatId],
        );
        await tx.client.query(
          `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,text) VALUES($1,$2,0,'text',$3)`,
          [chatId, ids.response, schemaRevertSummary(label, revert)],
        );
        await tx.client.query(
          `INSERT INTO ${s}.tf_conversation_results(conversation_id,turn_id,message_id,sources) VALUES($1,$2,$3,$4)`,
          [
            chatId,
            ids.turn,
            ids.response,
            JSON.stringify([
              { kind: 'private-conversation', conversationId: chatId },
              { kind: 'table-rows', tableId, revision: revert.plan.expectedRevision },
            ]),
          ],
        );
        await recordConversationActivity(tx, chatId);
        await notifyConversationChange(tx, { workspaceId, conversationId: chatId, turnId: ids.turn });
        return { actor, revert, done: false };
      });
      if (started.done) return { chatId };
      const plan = started.revert?.plan;
      const input = { plans: plan ? [plan] : [], label: 'Revert schema change' };
      // The proposal belongs to this chat's turn, so it is reviewed and approved like any chat proposal.
      let result: unknown;
      let failure: string | null = plan ? null : unavailable;
      if (plan)
        try {
          result = await proposals.propose(
            workspaceId,
            started.actor,
            ids.proposal,
            { conversationId: chatId, turnId: ids.turn, sources: [] },
            input,
          );
        } catch (error) {
          if (error instanceof TableProposalValidationError)
            result = blockedTableProposalSchema.parse(error.validation);
          else if (error instanceof TableProposalError) failure = failures[error.code] ?? unavailable;
          else throw error;
        }
      await options.runtime.transaction(workspaceId, executionCompatibility, async tx => {
        const s = `"${tx.schema}"`;
        if (failure === null && plan) {
          await tx.client.query(
            `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,tool,status,sequence) VALUES($1,$2,$3,'tables.propose','completed',1) ON CONFLICT (id) DO NOTHING`,
            [ids.proposal, chatId, ids.turn],
          );
          await tx.client.query(
            `INSERT INTO ${s}.tf_conversation_execution_steps(call_id,turn_id,call,sources,output) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [
              ids.proposal,
              ids.turn,
              JSON.stringify({ tool: 'tables.propose', input: JSON.stringify(input) }),
              JSON.stringify([{ kind: 'private-conversation', conversationId: chatId }]),
              JSON.stringify({
                result,
                sources: blockedTableProposalSchema.safeParse(result).success
                  ? [{ kind: 'table-rows', tableId, revision: plan.expectedRevision }]
                  : [],
              }),
            ],
          );
        } else
          await tx.client.query(
            `UPDATE ${s}.tf_conversation_parts SET text=$3 WHERE conversation_id=$1 AND message_id=$2 AND ordinal=0`,
            [chatId, ids.response, failure],
          );
        await tx.client.query(
          `UPDATE ${s}.tf_conversation_turns SET status='completed',response_message_id=$2 WHERE id=$1 AND status<>'completed'`,
          [ids.turn, ids.response],
        );
        await notifyConversationChange(tx, { workspaceId, conversationId: chatId, turnId: ids.turn });
      });
      return { chatId };
    },
  };
}
