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

export async function storedToolStatus(
  tx: AuthorizationTransaction,
  row: { id: string; tool: string; status: string; output?: unknown },
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
