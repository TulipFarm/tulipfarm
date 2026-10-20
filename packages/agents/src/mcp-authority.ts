import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  githubTaskContext,
  protectedSourceClosure,
  requireTaskInvocation,
  withoutGitHubSourcesBefore,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import type { WorkspaceMcpOptions } from '@tulipfarm/workspace-mcp';
import { sourceDependenciesSchema, mergeSources, type SourceDependency } from '@tulipfarm/conversations/results';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { requireDraftSources, requireTaskDefinitionSources } from './draft-sources.ts';
import { agentDefinitionSchema, toolCallSchema, toolResultSchema } from './contracts.ts';
import { relation } from './store.ts';
import { taskSourcesSchema } from './task-contracts.ts';
import { createAgentTasks } from './tasks.ts';
import { boundRuntime, lockTask } from './task-approval-gate.ts';

export const authorizeMcpSources: WorkspaceMcpOptions['authorizeSources'] = async ({ transaction, actor, sources }) => {
  await requireDraftSources(transaction, actor, sources);
};

export const authorizeMcpSelection: NonNullable<WorkspaceMcpOptions['authorizeSelection']> = async ({
  transaction: tx,
  actor,
  subject,
}) => {
  await currentMember(tx, actor);
  if (subject.kind === 'chat') {
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_conversations')} c WHERE c.id=$1 AND c.kind='private' AND c.owner_user_id=$2 AND c.owner_membership_id=$3 AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_slack_default_turns')} s WHERE s.conversation_id=c.id) AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_slack_dm_roots')} s WHERE s.conversation_id=c.id)`,
          [subject.id, actor.userId, actor.membershipId],
        )
      ).rowCount
    )
      throw new AccessDenied();
    return { sources: [{ kind: 'private-conversation', conversationId: subject.id }], slots: null };
  }
  let agentId: string;
  let definition;
  if (subject.kind === 'task') {
    const task = z
      .object({ agent_id: z.uuid(), definition: agentDefinitionSchema })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT t.agent_id,d.definition FROM ${relation(tx, 'tf_agent_tasks')} t JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=t.agent_id AND d.revision=t.definition_revision JOIN ${relation(tx, 'tf_agent_activations')} a ON a.id=t.activation_id WHERE t.id=$1 AND t.owner_user_id=$2 AND t.owner_membership_id=$3 AND a.revoked_at IS NULL`,
            [subject.id, actor.userId, actor.membershipId],
          )
        ).rows[0],
      );
    if (!task) throw new AccessDenied();
    agentId = task.agent_id;
    definition = task.definition;
  } else {
    agentId = subject.agentId;
    const definitions = z
      .array(z.object({ definition: agentDefinitionSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT d.definition FROM ${relation(tx, 'tf_agent_activations')} a JOIN ${relation(tx, 'tf_agents')} g ON g.id=a.agent_id JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=a.agent_id AND d.revision=a.definition_revision WHERE a.agent_id=$1 AND a.revoked_at IS NULL AND g.enabled AND g.deleted_at IS NULL ORDER BY a.activated_at DESC NULLS LAST,a.id DESC LIMIT 2`,
            [agentId],
          )
        ).rows,
      );
    if (definitions.length !== 1 || !definitions[0]) throw new AccessDenied();
    definition = definitions[0].definition;
  }
  await requireTaskInvocation(tx, actor, agentId);
  const slots = (definition.mcp ?? []).map(slot => ({
    slotId: slot.id,
    serverIdentity: slot.serverIdentity,
    tools: slot.tools,
    ...(slot.integrationId ? { integrationId: slot.integrationId } : {}),
  }));
  for (const slot of slots)
    if (
      slot.integrationId &&
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_mcp_integrations')} WHERE id=$1 AND ownership='shared' AND server_identity=$2`,
          [slot.integrationId, slot.serverIdentity],
        )
      ).rowCount
    )
      throw new AccessDenied();
  return { sources: subject.kind === 'task' ? await taskMcpSources(tx, actor, subject.id) : [], slots };
};

async function selectedSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  originKey: string,
): Promise<SourceDependency[]> {
  const row = (
    await tx.client.query(
      `SELECT bindings FROM ${relation(tx, 'tf_mcp_selections')} WHERE membership_id=$1 AND origin_key=$2`,
      [actor.membershipId, originKey],
    )
  ).rows[0];
  const bindings = z
    .array(z.object({ integrationId: z.uuid(), authorizationEpoch: z.int().positive() }))
    .parse(row?.bindings ?? []);
  return sourceDependenciesSchema.parse(bindings.map(binding => ({ kind: 'mcp-integration', ...binding })));
}

async function chatSources(tx: AuthorizationTransaction, conversationId: string, turnId: string) {
  const result: SourceDependency[] = [{ kind: 'private-conversation', conversationId }];
  const prior = await tx.client.query(
    `SELECT r.sources FROM ${relation(tx, 'tf_conversation_results')} r JOIN ${relation(tx, 'tf_conversation_turns')} t ON t.id=r.turn_id WHERE r.conversation_id=$1 AND t.accepted_sequence<(SELECT accepted_sequence FROM ${relation(tx, 'tf_conversation_turns')} WHERE id=$2) LIMIT 1001`,
    [conversationId, turnId],
  );
  if (prior.rows.length > 1000) throw new AccessDenied();
  for (const row of prior.rows) result.push(...sourceDependenciesSchema.parse(row.sources));
  const models = await tx.client.query(
    `SELECT sources FROM ${relation(tx, 'tf_conversation_model_sources')} WHERE turn_id=$1`,
    [turnId],
  );
  for (const row of models.rows) result.push(...sourceDependenciesSchema.parse(row.sources));
  const steps = await tx.client.query(
    `SELECT sources,output FROM ${relation(tx, 'tf_conversation_execution_steps')} WHERE turn_id=$1`,
    [turnId],
  );
  for (const row of steps.rows) {
    result.push(...sourceDependenciesSchema.parse(row.sources));
    if (row.output !== null) result.push(...z.object({ sources: sourceDependenciesSchema }).parse(row.output).sources);
  }
  return mergeSources(result);
}

export async function taskMcpSources(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  taskId: string,
  runId?: string,
): Promise<SourceDependency[]> {
  const result: SourceDependency[] = sourceDependenciesSchema.parse([{ kind: 'private-task', taskId }]);
  const visited = new Set<string>();
  const pending = [{ taskId, throughSequence: 2147483647 }];
  const compact = z
    .string()
    .regex(/^ws_[a-f0-9]{32}$/)
    .parse(tx.schema)
    .slice(3);
  const workspaceId = z
    .uuid()
    .parse(
      `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`,
    );
  const metadata = {
    workspace_id: workspaceId,
    common_version: z
      .number()
      .parse(
        (await tx.client.query(`SELECT count(*)::integer AS version FROM ${relation(tx, 'tf_common_migrations')}`))
          .rows[0]?.version,
      ),
  };
  const tasks = createAgentTasks(
    boundRuntime({ ...tx, commonVersion: metadata.common_version }, metadata.workspace_id),
  );
  result.push(...(await selectedSources(tx, actor, `task:${taskId}`)));
  for (const reference of pending) {
    const key = `${reference.taskId}:${reference.throughSequence}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > 100) throw new AccessDenied();
    result.push({ kind: 'private-task', taskId: reference.taskId });
    const github = await githubTaskContext(tx, reference.taskId);
    if (reference.throughSequence < github.sequence) throw new AccessDenied();
    {
      const models = await tx.client.query(
        `SELECT mcp_sources FROM ${relation(tx, 'tf_agent_task_steps')} WHERE task_id=$1 LIMIT 1001`,
        [reference.taskId],
      );
      if (models.rows.length > 1000) throw new AccessDenied();
      for (const row of models.rows)
        result.push(
          ...sourceDependenciesSchema.parse(
            withoutGitHubSourcesBefore(row.mcp_sources, reference.taskId, github.generation),
          ),
        );
    }
    const rows = await tx.client.query(
      `SELECT sources FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sequence<=$2 AND sequence>=$3 ORDER BY sequence LIMIT 1001`,
      [reference.taskId, reference.throughSequence, github.sequence],
    );
    if (!rows.rowCount || rows.rows.length > 1000) throw new AccessDenied();
    for (const row of rows.rows) {
      const sources = taskSourcesSchema.parse(row.sources);
      if (runId) await tasks.checkSources(metadata.workspace_id, actor.userId, sources, runId);
      else await tasks.history(metadata.workspace_id, actor.userId, reference.taskId, { after: -1, limit: 100 });
      for (const source of sources) {
        if (source.kind === 'task') pending.push(source);
        else if (source.kind === 'attachment')
          result.push({ kind: 'private-conversation', conversationId: source.conversationId });
        else if (source.kind !== 'file' && source.kind !== 'google-drive-file') result.push(source);
      }
    }
    const receipts = await tx.client.query(
      `SELECT c.result FROM ${relation(tx, 'tf_agent_tool_calls')} c JOIN ${relation(tx, 'tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 AND c.call->>'tool' LIKE 'mcp.%' AND c.result->>'kind'='receipt'`,
      [reference.taskId],
    );
    for (const row of receipts.rows)
      result.push(...z.object({ sources: sourceDependenciesSchema }).parse(row.result).sources);
    const native = z
      .array(z.object({ call: toolCallSchema, result: toolResultSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT c.call,c.result FROM ${relation(tx, 'tf_agent_tool_calls')} c JOIN ${relation(tx, 'tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 LIMIT 1001`,
            [reference.taskId],
          )
        ).rows,
      );
    if (native.length > 1000) throw new AccessDenied();
    for (const row of native) {
      if ('tableId' in row.call) result.push({ kind: 'table', tableId: row.call.tableId });
      if (row.call.tool === 'tables.list' && row.result && typeof row.result === 'object' && 'tables' in row.result)
        result.push(...row.result.tables.map(resource => ({ kind: 'table' as const, tableId: resource.id })));
    }
    const admitted = z
      .array(z.object({ source_tables: z.array(z.uuid()) }))
      .parse(
        (
          await tx.client.query(
            `SELECT source_tables FROM ${relation(tx, 'tf_agent_task_steps')} WHERE task_id=$1 LIMIT 1001`,
            [reference.taskId],
          )
        ).rows,
      );
    if (admitted.length > 1000) throw new AccessDenied();
    for (const row of admitted) result.push(...row.source_tables.map(tableId => ({ kind: 'table' as const, tableId })));
  }
  return mergeSources(await protectedSourceClosure(tx, result));
}

export const authorizeMcpOrigin: WorkspaceMcpOptions['authorizeOrigin'] = async ({
  transaction: tx,
  actor,
  origin,
  phase,
}) => {
  await currentMember(tx, actor);
  if (origin.kind === 'private-chat') {
    const requester = await turnRequester(tx, origin.conversationId, origin.turnId);
    if (requester.userId !== actor.userId || requester.membershipId !== actor.membershipId) throw new AccessDenied();
    const row = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_conversations')} c JOIN ${relation(tx, 'tf_conversation_turns')} t ON t.conversation_id=c.id WHERE c.id=$1 AND t.id=$2 AND c.kind='private' AND c.owner_user_id=$3 AND c.owner_membership_id=$4 AND ($5 OR t.status IN ('queued','processing','waiting')) AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_slack_default_turns')} e WHERE e.conversation_id=c.id) AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_slack_dm_roots')} e WHERE e.conversation_id=c.id)`,
        [
          origin.conversationId,
          origin.turnId,
          actor.userId,
          actor.membershipId,
          phase === 'read' || phase === 'select',
        ],
      )
    ).rowCount;
    if (!row) throw new AccessDenied();
    if (phase === 'propose' || phase === 'dispatch' || phase === 'approve') {
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_conversation_execution_steps')} s JOIN ${relation(tx, 'tf_conversation_tool_calls')} c ON c.id=s.call_id WHERE s.call_id=$1 AND s.turn_id=$2 AND c.tool='mcp.call' AND c.status='running'`,
            [origin.stepId, origin.turnId],
          )
        ).rowCount
      )
        throw new AccessDenied();
    }
    const sources = mergeSources([
      ...(await chatSources(tx, origin.conversationId, origin.turnId)),
      ...(await selectedSources(tx, actor, `chat:${origin.conversationId}`)),
    ]);
    await authorizeMcpSources({ transaction: tx, actor, sources });
    return { sources, allowedTools: null };
  }
  await lockTask(tx, origin.taskId);
  const task = z
    .object({
      agent_id: z.uuid(),
      definition_revision: z.string(),
      activation_id: z.uuid(),
      generation: z.number(),
      status: z.string(),
      definition: agentDefinitionSchema,
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT t.*,d.definition FROM ${relation(tx, 'tf_agent_tasks')} t JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=t.agent_id AND d.revision=t.definition_revision WHERE t.id=$1 AND t.owner_user_id=$2 AND t.owner_membership_id=$3`,
          [origin.taskId, actor.userId, actor.membershipId],
        )
      ).rows[0],
    );
  if (!task) throw new AccessDenied();
  for (const slot of task.definition.mcp ?? [])
    if (
      slot.integrationId &&
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_mcp_integrations')} WHERE id=$1 AND ownership='shared' AND server_identity=$2`,
          [slot.integrationId, slot.serverIdentity],
        )
      ).rowCount
    )
      throw new AccessDenied();
  await requireTaskInvocation(tx, actor, task.agent_id);
  if (!['select', 'read'].includes(phase) && !['pending', 'waiting-approval'].includes(task.status))
    throw new AccessDenied();
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_agent_activations')} a JOIN ${relation(tx, 'tf_agents')} g ON g.id=a.agent_id WHERE a.id=$1 AND a.revoked_at IS NULL AND g.enabled AND g.deleted_at IS NULL`,
        [task.activation_id],
      )
    ).rowCount
  )
    throw new AccessDenied();
  const run = z
    .object({ run_id: z.uuid() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT b.run_id FROM ${relation(tx, 'tf_agent_task_runs')} b JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=b.run_id WHERE b.task_id=$1 AND b.generation=$2 AND r.kind='delegated' AND r.user_id=$3 AND r.membership_id=$4 AND r.status IN ('ready','running','waiting')`,
          [origin.taskId, task.generation, actor.userId, actor.membershipId],
        )
      ).rows[0],
    );
  if (phase === 'propose' || phase === 'dispatch' || phase === 'approve') {
    if (
      !run ||
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=$1 AND run_id=$2 AND call->>'tool'='mcp.call' AND status IN ('pending','waiting')`,
          [origin.stepId, run.run_id],
        )
      ).rowCount
    )
      throw new AccessDenied();
  }
  await requireTaskDefinitionSources(tx, actor, origin.taskId, run?.run_id);
  const sources = await taskMcpSources(tx, actor, origin.taskId, run?.run_id);
  await authorizeMcpSources({ transaction: tx, actor, sources });
  const selected = (
    await tx.client.query(
      `SELECT bindings FROM ${relation(tx, 'tf_mcp_selections')} WHERE membership_id=$1 AND origin_key=$2`,
      [actor.membershipId, `task:${origin.taskId}`],
    )
  ).rows[0];
  const bindings = z
    .array(
      z.object({
        integrationId: z.uuid(),
        authorizationEpoch: z.int().positive(),
        slotId: z.string().nullable().optional(),
      }),
    )
    .parse(selected?.bindings ?? []);
  const allowedTools = [];
  for (const binding of bindings) {
    const slot = task.definition.mcp?.find(slot => slot.id === binding.slotId);
    if (!slot || (slot.integrationId && slot.integrationId !== binding.integrationId)) throw new AccessDenied();
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_mcp_integrations')} WHERE id=$1 AND server_identity=$2 AND authorization_epoch=$3 AND (ownership='shared' OR descriptor_approved)`,
          [binding.integrationId, slot.serverIdentity, binding.authorizationEpoch],
        )
      ).rowCount
    )
      throw new AccessDenied();
    allowedTools.push(
      ...slot.tools.map(tool => ({
        slotId: slot.id,
        serverIdentity: slot.serverIdentity,
        ...tool,
        integrationId: binding.integrationId,
      })),
    );
  }
  return { sources, allowedTools };
};
