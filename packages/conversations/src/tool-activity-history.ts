import { z } from 'zod';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import {
  toolPresentation,
  toolOutcomeStatus,
  type ToolPresentation,
  type activityStatusSchema,
} from './tool-activity.ts';

const reference = z.object({ proposalId: z.uuid().optional(), batchId: z.uuid().optional() });
const operationRow = z.object({ operation: z.object({ kind: z.string() }).passthrough() });

export async function storedToolPresentation(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  tool: string,
  call: unknown,
  activity?: string | null,
  callId?: string,
): Promise<ToolPresentation> {
  const table = (name: string) => qualified(tx.schema, name);
  const input = reference.safeParse(call);
  if (
    input.success &&
    input.data.proposalId &&
    ['google.status', 'google.execute', 'atlassian.proposal', 'atlassian.execute'].includes(tool)
  ) {
    const google = tool.startsWith('google.');
    const name = google ? 'tf_google_proposals' : 'tf_atlassian_proposals';
    if ((await tx.client.query('SELECT to_regclass($1) AS name', [table(name)])).rows[0]?.name) {
      const row = operationRow
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT operation FROM ${table(name)} WHERE id=$1 AND membership_id=$2`, [
              input.data.proposalId,
              actor.membershipId,
            ])
          ).rows[0],
        );
      if (row) {
        const provider = google ? 'google' : 'atlassian';
        const value = toolPresentation(`${provider}.propose`, {
          tool: `${provider}.propose`,
          operation: row.operation,
        });
        return {
          ...value,
          label: `${tool.endsWith('.execute') ? 'Executing approved action' : 'Checking approval and outcome'}: ${value.label.replace(/^Preparing: /, '')}`,
        };
      }
    }
  }
  if (
    tool === 'github.personal.execute' &&
    input.success &&
    input.data.batchId &&
    (await tx.client.query('SELECT to_regclass($1) AS name', [table('tf_github_batches')])).rows[0]?.name
  ) {
    const row = (
      await tx.client.query(`SELECT snapshot FROM ${table('tf_github_batches')} WHERE id=$1 AND membership_id=$2`, [
        input.data.batchId,
        actor.membershipId,
      ])
    ).rows[0];
    const snapshot = z.object({ actions: z.array(z.object({ kind: z.string() })) }).safeParse(row?.snapshot);
    if (snapshot.success) {
      const value = toolPresentation('github.personal.propose', {
        tool: 'github.personal.propose',
        actions: snapshot.data.actions,
      });
      return { ...value, label: `Executing approved batch: ${value.label.replace(/^Preparing: /, '')}`.slice(0, 240) };
    }
  }
  if (
    tool === 'mcp.call' &&
    callId &&
    (await tx.client.query('SELECT to_regclass($1) AS name', [table('tf_mcp_actions')])).rows[0]?.name
  ) {
    const row = z
      .object({ tool_name: z.string() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT tool_name FROM ${table('tf_mcp_actions')} WHERE id=$1 AND requester->>'membershipId'=$2`,
            [callId, actor.membershipId],
          )
        ).rows[0],
      );
    if (row) return { label: `Calling ${row.tool_name}`.slice(0, 240), brand: null };
  }
  const handle = z.object({ handle: z.string() }).safeParse(call);
  if (
    (tool === 'mcp.describe' || tool === 'mcp.call') &&
    callId &&
    handle.success &&
    (await tx.client.query('SELECT to_regclass($1) AS name', [table('tf_conversation_execution_steps')])).rows[0]?.name
  ) {
    const row = (
      await tx.client.query(
        `SELECT item->>'name' AS name FROM ${table('tf_conversation_execution_steps')} previous JOIN ${table('tf_conversation_tool_calls')} current ON current.turn_id=previous.turn_id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(previous.output->'result'->'tools','[]'::jsonb)) item WHERE current.id=$1 AND item->>'handle'=$2 LIMIT 1`,
        [callId, handle.data.handle],
      )
    ).rows[0];
    const name = z.string().max(256).safeParse(row?.name);
    if (name.success)
      return { label: `${tool === 'mcp.describe' ? 'Inspecting' : 'Calling'} ${name.data}`.slice(0, 240), brand: null };
  }
  return toolPresentation(tool, call, activity);
}

/**
 * True for proposal `p` when a newer, unrejected proposal from the same person
 * in the same chat replaces it: it names `p` in `revises`, or redesigns the
 * same table, or proposes a new table with the same title.
 */
export const tableProposalSupersededCondition = (table: (name: string) => string) =>
  `EXISTS (SELECT 1 FROM ${table('tf_table_proposals')} n WHERE n.conversation_id=p.conversation_id AND n.membership_id=p.membership_id AND (n.created_at,n.id)>(p.created_at,p.id)
    AND NOT EXISTS (SELECT 1 FROM ${table('tf_table_proposal_decisions')} nd WHERE nd.proposal_id=n.id AND nd.decision='reject')
    AND (n.manifest->>'revises'=p.id::text OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(n.manifest->'plans') np, jsonb_array_elements(p.manifest->'plans') op
      WHERE np->'input'->>'kind'='schema' AND op->'input'->>'kind'='schema'
        AND (np->'input'->>'tableId'=op->'input'->>'tableId'
          OR (jsonb_typeof(np->'before')='null' AND jsonb_typeof(op->'before')='null'
            AND lower(btrim(np->'after'->>'label'))=lower(btrim(op->'after'->>'label')))))))`;

// A proposal's tool result is saved as pending; its review happens later, so read its current state.
async function tableProposalActivity(tx: AuthorizationTransaction, id: string): Promise<StoredToolActivity | null> {
  const table = (name: string) => qualified(tx.schema, name);
  if (!(await tx.client.query('SELECT to_regclass($1) AS name', [table('tf_table_proposals')])).rows[0]?.name)
    return null;
  const row = (
    await tx.client.query(
      `SELECT p.expires_at<=clock_timestamp() AS expired,jsonb_array_length(p.manifest->'plans') AS plans,
        (SELECT decision FROM ${table('tf_table_proposal_decisions')} WHERE proposal_id=p.id) AS decision,
        (SELECT operation FROM ${table('tf_table_proposal_controls')} WHERE proposal_id=p.id ORDER BY sequence DESC LIMIT 1) AS control,
        r.completed,r.failed,${tableProposalSupersededCondition(table)} AS superseded
      FROM ${table('tf_table_proposals')} p
      CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE receipt->>'status'='completed')::int AS completed,count(*) FILTER (WHERE receipt->>'status'='failed')::int AS failed
        FROM (SELECT DISTINCT ON(table_id) receipt FROM ${table('tf_table_proposal_receipts')} WHERE proposal_id=p.id ORDER BY table_id,attempt DESC) latest) r
      WHERE p.id=$1`,
      [id],
    )
  ).rows[0];
  const proposal = z
    .object({
      expired: z.boolean(),
      plans: z.int(),
      decision: z.enum(['approve', 'reject']).nullable(),
      control: z.enum(['cancel', 'resume']).nullable(),
      completed: z.int(),
      failed: z.int(),
      superseded: z.boolean(),
    })
    .safeParse(row);
  if (!proposal.success) return null;
  const value = proposal.data;
  if (value.completed === value.plans) return { status: 'completed' };
  if (value.decision === 'reject') return { status: 'blocked' };
  if (value.control === 'cancel' || value.expired) return { status: 'cancelled' };
  if (value.completed || value.failed) return { status: 'failed' };
  if (value.decision === 'approve') return { status: 'running' };
  return value.superseded ? { status: 'completed', detail: 'Replaced by a revision.' } : { status: 'waiting' };
}

type StoredToolRow = { id: string; tool: string; status: string; call?: unknown; output?: unknown };
// Expected answers that prepare no review: the reply explains each one, so the step itself did not fail.
const proposalOutcomes = new Map(
  Object.entries({
    'invalid-arguments': 'Corrected and resubmitted.',
    'workflow-active': 'Not archived: an active workflow uses this table.',
    'table-linked': 'Not archived: another table links to this table.',
    'invalid-transform': 'No review prepared: some row values don’t fit the changed fields.',
    'import-not-prepared': 'No review prepared: the file wasn’t read first.',
  }),
);
// Import plans that don't fit the file or table explain every problem in their own `reason`.
const importPlanOutcomes = new Set(['import-values-invalid', 'import-mapping-invalid']);
const askTableAccess = 'Ask a workspace admin to grant';
// Admins hold every table permission, so a denial means something the step used changed, never a missing grant.
export const adminTableDenial =
  'Access denied. As a workspace admin you already have every table permission, so a table or file this step used changed or isn’t available to this chat. Ask again to retry.';
const proposalPlans = z.object({
  plans: z.array(z.object({ kind: z.string(), expectedRevision: z.string().nullable().optional() })).min(1),
});

/** Names the permissions a denied `tables.propose` call needed, from the kinds of change it asked for. */
export function deniedProposalDetail(call: unknown) {
  const input = z.object({ input: z.string() }).safeParse(call);
  if (!input.success) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input.data.input);
  } catch {
    return undefined;
  }
  const parsed = proposalPlans.safeParse(value);
  if (!parsed.success) return undefined;
  const plans = parsed.data.plans;
  if (plans.every(plan => plan.kind === 'schema' && plan.expectedRevision === null))
    return `Access denied. Adding this table needs Create tables for its owning team. ${askTableAccess} it to you or your team in Table access, then ask again.`;
  if (
    plans.every(plan => ['archive', 'restore'].includes(plan.kind) || (plan.kind === 'schema' && plan.expectedRevision))
  )
    return `Access denied. This change needs Read rows and Manage schema on the table. ${askTableAccess} them to you or your team in Table access, then ask again.`;
  if (plans.every(plan => plan.kind === 'records' || plan.kind === 'import'))
    return `Access denied. This change needs Read rows plus Create rows, Update rows or Delete rows on the table, depending on the change. ${askTableAccess} them to you or your team in Table access, then ask again.`;
  return undefined;
}
const rowWriteTools = new Set(['rows.create', 'rows.create.batch', 'rows.update', 'rows.delete']);
const rowReviewReasons: Record<string, (table?: string) => string> = {
  'too-many-rows': () => 'Changes to more than 5 rows in one request need your approval on a chat card.',
  'table-not-named': table =>
    `Rows are written directly only to a table you named${table ? `, and you didn’t name ${table.slice(0, 80)}` : ''}. This change needs your approval on a chat card.`,
  'table-change-pending': () => 'This reply prepared a table change, so row changes need your approval on a chat card.',
};
const rowReviewOutput = z.object({
  error: z.string().optional(),
  draftId: z.string().optional(),
  reason: z.string().optional(),
  table: z.string().optional(),
});

/**
 * Why a chat row write was held for approval instead of written, so Tool activity names the rule rather than a
 * generic failure. Undefined for writes that ran or failed for another reason.
 */
export function rowReviewDetail(tool: string, output: unknown) {
  if (!rowWriteTools.has(tool)) return undefined;
  const wrapped = z.object({ result: z.unknown() }).safeParse(output);
  const parsed = rowReviewOutput.safeParse(wrapped.success ? wrapped.data.result : output);
  if (!parsed.success) return undefined;
  const { error, draftId, reason, table } = parsed.data;
  const why = reason ? rowReviewReasons[reason]?.(table) : undefined;
  if (error === 'review-unavailable')
    return 'Not written: this chat used content that can’t be shown for review, so it can’t change rows. Make the change in the table.';
  if (error === 'review-required')
    return `Not written. ${why ?? 'This chat used outside content, so each row change needs your approval on a chat card.'}`;
  if (error === 'approval-pending')
    return `Not written: a row change${table ? ` to ${table.slice(0, 80)}` : ''} in this chat is still waiting for your approval. Approve or reject that card first.`;
  if (error === 'batch-required')
    return 'Not written: several new rows in one reply go together in one change, so they can be approved together.';
  if (draftId && why) return `Not written yet. ${why}`;
  return undefined;
}

/**
 * `proposal` marks a `tables.propose` call that saved a proposal, so its review card stays valid even if the reply failed.
 * `workflows` are the active workflows that blocked an archive, as the requester could read them when it ran.
 */
export type StoredToolActivity = {
  status: z.infer<typeof activityStatusSchema>;
  detail?: string;
  proposal?: true;
  workflows?: BlockingWorkflow[];
};
type BlockingWorkflow = z.infer<typeof blockingWorkflowsSchema>[number];
const blockingWorkflowsSchema = z.array(z.object({ id: z.uuid(), name: z.string().min(1).max(256) })).max(5);

/** The step's current status, and a note when its saved result alone would mislead. */
export async function storedToolActivity(
  tx: AuthorizationTransaction,
  row: StoredToolRow,
  viewer: { admin?: boolean } = {},
): Promise<StoredToolActivity> {
  if (row.status === 'blocked' && row.tool === 'tables.propose') {
    const detail = viewer.admin ? adminTableDenial : deniedProposalDetail(row.call);
    if (detail) return { status: 'blocked', detail };
  }
  if (row.status === 'completed' && row.tool === 'tables.propose') {
    const result = z.object({ result: z.unknown() }).safeParse(row.output);
    const output = result.success ? result.data.result : row.output;
    const outcome = z
      .object({ error: z.string(), reason: z.string().min(1).optional(), workflows: z.unknown().optional() })
      .safeParse(output);
    const error = outcome.success ? outcome.data.error : undefined;
    const detail =
      error === 'invalid-arguments' && !(await resubmitted(tx, row.id))
        ? 'No review prepared: the request wasn’t valid.'
        : error && importPlanOutcomes.has(error) && outcome.data?.reason
          ? outcome.data.reason.slice(0, 400)
          : error && proposalOutcomes.get(error);
    const workflows =
      error === 'workflow-active' ? blockingWorkflowsSchema.safeParse(outcome.data?.workflows).data : undefined;
    if (detail) return { status: 'completed', detail, ...(workflows?.length ? { workflows } : {}) };
    const proposal = z.object({ id: z.uuid(), status: z.literal('pending') }).safeParse(output);
    const activity = proposal.success ? await tableProposalActivity(tx, proposal.data.id) : null;
    if (activity) return { ...activity, proposal: true };
  }
  if (row.status === 'completed' && row.tool === 'tables.import.file') {
    const result = z.object({ result: z.unknown() }).safeParse(row.output);
    const failure = z
      .object({ error: z.literal('import-file-failed'), reason: z.string().min(1) })
      .safeParse(result.success ? result.data.result : row.output);
    if (failure.success) return { status: 'failed', detail: failure.data.reason.slice(0, 400) };
  }
  const status = await savedToolStatus(tx, row);
  const detail = row.status === 'completed' ? rowReviewDetail(row.tool, row.output) : undefined;
  return detail ? { status, detail } : { status };
}

/** Whether chat called `tables.propose` again later in the same reply, after this call's invalid arguments. */
async function resubmitted(tx: AuthorizationTransaction, callId: string) {
  const table = qualified(tx.schema, 'tf_conversation_tool_calls');
  const result = await tx.client.query(
    `SELECT 1 FROM ${table} later JOIN ${table} call ON call.id=$1 WHERE later.turn_id=call.turn_id AND later.tool='tables.propose' AND later.sequence>call.sequence LIMIT 1`,
    [callId],
  );
  return Boolean(result.rowCount);
}

export async function storedToolStatus(
  tx: AuthorizationTransaction,
  row: StoredToolRow,
): Promise<z.infer<typeof activityStatusSchema>> {
  return (await storedToolActivity(tx, row)).status;
}

async function savedToolStatus(
  tx: AuthorizationTransaction,
  row: StoredToolRow,
): Promise<z.infer<typeof activityStatusSchema>> {
  const table = (name: string) => qualified(tx.schema, name);
  const result = z
    .object({ provider: z.never().optional(), result: z.unknown(), sources: z.array(z.unknown()) })
    .safeParse(row.output);
  if (row.status === 'completed') return toolOutcomeStatus(result.success ? result.data.result : row.output);
  if (row.status === 'blocked' || row.status === 'failed') return row.status;
  if (
    row.tool === 'mcp.call' &&
    (await tx.client.query('SELECT to_regclass($1) AS name', [table('tf_mcp_actions')])).rows[0]?.name
  ) {
    const action = (
      await tx.client.query(
        `SELECT r.status,c.deadline,d.decision,x.action_id AS cancelled,p.action_id AS permitted FROM ${table('tf_mcp_actions')} a LEFT JOIN ${table('tf_mcp_claims')} c ON c.action_id=a.id LEFT JOIN ${table('tf_mcp_receipts')} r ON r.action_id=a.id LEFT JOIN ${table('tf_mcp_decisions')} d ON d.action_id=a.id LEFT JOIN ${table('tf_mcp_cancellations')} x ON x.action_id=a.id LEFT JOIN ${table('tf_mcp_policy_evaluations')} p ON p.action_id=a.id WHERE a.id=$1`,
        [row.id],
      )
    ).rows[0];
    if (action?.status === 'succeeded') return 'completed';
    if (action?.status === 'outcome-unknown') return 'unknown';
    if (action?.cancelled) return 'cancelled';
    if (action?.decision === 'reject') return 'blocked';
    if (action && !action.deadline) return action.decision === 'approve' || action.permitted ? 'queued' : 'waiting';
  }
  if (
    row.tool === 'api.request' &&
    (await tx.client.query('SELECT to_regclass($1) AS name', [table('tf_api_calls')])).rows[0]?.name
  ) {
    const call = (
      await tx.client.query(
        `SELECT a.status,d.decision FROM ${table('tf_api_calls')} a LEFT JOIN ${table('tf_api_call_decisions')} d ON d.call_id=a.id WHERE a.id=$1`,
        [row.id],
      )
    ).rows[0];
    if (call?.status === 'awaiting-approval') return call.decision ? 'queued' : 'waiting';
  }
  if (
    row.status === 'waiting' &&
    [
      'google.read',
      'google.propose',
      'google.status',
      'google.execute',
      'github.personal.read',
      'github.personal.download',
      'github.issue.read',
    ].includes(row.tool)
  )
    return 'running';
  return row.status === 'pending' ? 'queued' : row.status === 'waiting' ? 'waiting' : 'running';
}
