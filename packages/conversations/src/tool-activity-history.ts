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
async function tableProposalStatus(
  tx: AuthorizationTransaction,
  id: string,
): Promise<z.infer<typeof activityStatusSchema> | null> {
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
  if (value.completed === value.plans) return 'completed';
  if (value.decision === 'reject') return 'blocked';
  if (value.control === 'cancel' || value.expired) return 'cancelled';
  if (value.completed || value.failed) return 'failed';
  if (value.decision === 'approve') return 'running';
  return value.superseded ? 'cancelled' : 'waiting';
}

export async function storedToolStatus(
  tx: AuthorizationTransaction,
  row: { id: string; tool: string; status: string; output?: unknown },
): Promise<z.infer<typeof activityStatusSchema>> {
  const table = (name: string) => qualified(tx.schema, name);
  const result = z
    .object({ provider: z.never().optional(), result: z.unknown(), sources: z.array(z.unknown()) })
    .safeParse(row.output);
  if (row.status === 'completed' && row.tool === 'tables.propose') {
    const output = result.success ? result.data.result : row.output;
    // No proposal exists; the assistant is told to correct its input and propose again.
    if (z.object({ error: z.literal('invalid-arguments') }).safeParse(output).success) return 'cancelled';
    const proposal = z.object({ id: z.uuid(), status: z.literal('pending') }).safeParse(output);
    const status = proposal.success ? await tableProposalStatus(tx, proposal.data.id) : null;
    if (status) return status;
  }
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
