import { createHash, randomUUID } from 'node:crypto';
import { knowledgeRootForRequest, type KnowledgeRootOrigin } from './knowledge-retrieval.ts';
import { z } from 'zod';
import { knowledgeTaskUsage } from '@tulipfarm/workspace-storage/knowledge-credits';
import { activityReceiptSchema } from '@tulipfarm/conversations/tool-activity';
import { storedToolPresentation, storedToolStatus } from '@tulipfarm/conversations/tool-activity-history';
import {
  AccessDenied,
  githubTaskContext,
  canAccessAsset,
  lockAuthorization,
  requireCurrentActor,
  requireTaskInvocation,
  resolveHuman,
  uuidSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { agentDefinitionSchema, maximumTaskLimits, scopeSchema, toolNameSchema } from './contracts.ts';
import {
  protectedSourceClosure,
  requireProtectedSource,
  requireMcpSource,
  requireMcpTaskRun,
  requirePrivateTaskSource,
} from '@tulipfarm/access';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { resolveProcedures } from './workspace-skills.ts';
import { requireTaskDefinitionSources } from './draft-sources.ts';
import { bindFileSources } from '@tulipfarm/conversations/file-references';
import {
  AgentTaskError,
  taskReferenceMessageLimit,
  continueTaskSchema,
  delegatedTaskInputSchema,
  reopenTaskSchema,
  startTaskSchema,
  taskHistoryQuerySchema,
  taskLimitsSchema,
  taskListQuerySchema,
  taskMessageSchema,
  taskReceiptSchema,
  taskSourceSchema,
  taskSourcesSchema,
  taskSummarySchema,
  type OwnerTaskSource,
} from './task-contracts.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { taskTransition, withTaskTelemetry } from './task-telemetry.ts';
import { visiblePage } from './visible-page.ts';
import { delegatedRequestId, subagentLimits } from './subagent-contracts.ts';

const columns = `id, agent_id AS "agentId", activation_id AS "activationId", definition_revision AS "definitionRevision", parent_task_id AS "parentTaskId", delegation_depth AS "delegationDepth", delegation_tools AS "delegationTools", skills, scope, limits, flow_id AS "flowId", generation, status, pause_reason AS "pauseReason", active_milliseconds::text AS "activeMilliseconds", tool_calls AS "toolCalls", created_at::text AS "createdAt"`;
const storedSchema = taskSummarySchema
  .omit({ cost: true })
  .extend({ delegationTools: z.array(toolNameSchema).nullable() });
type Task = z.infer<typeof storedSchema>;
type Sources = z.infer<typeof taskSourcesSchema>;
type Scope = z.infer<typeof scopeSchema>;
type TaskLimits = z.infer<typeof taskLimitsSchema>;
const maximumDelegationDepth = 3;
const maximumChildTasks = 5;
const scheduledTaskSchema = z.strictObject({
  scheduleId: uuidSchema,
  agentId: uuidSchema,
  activationId: uuidSchema,
  scope: scopeSchema,
  limits: taskLimitsSchema,
  text: startTaskSchema.shape.text,
});
const googleIntegrationSchema = z.object({
  id: uuidSchema,
  account_id: z.string(),
  generation: z.number().int().positive(),
  scopes: z.array(z.string()),
});

/**
 * Binds each Google Drive input to the owner's current Google integration with Drive access. The binding is the server's,
 * so a later disconnect or account switch makes the input unavailable instead of reading through another account.
 */
async function bindGoogleInputs(
  tx: AgentTransaction,
  actor: HumanActor,
  sources: readonly OwnerTaskSource[],
): Promise<Sources> {
  if (!sources.some(source => source.kind === 'drive-file'))
    return sources.filter(source => source.kind !== 'drive-file');
  const installed =
    (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [relation(tx, 'tf_google_integrations')]))
      .rows[0]?.installed === true;
  const integration = installed
    ? googleIntegrationSchema.optional().parse(
        (
          await tx.client.query(
            `SELECT id,account_id,generation,scopes FROM ${relation(tx, 'tf_google_integrations')}
    WHERE membership_id=$1 AND user_id=$2 AND status='connected' AND account_id IS NOT NULL FOR SHARE`,
            [actor.membershipId, actor.userId],
          )
        ).rows[0],
      )
    : undefined;
  if (!integration?.scopes.includes('https://www.googleapis.com/auth/drive'))
    throw new AgentTaskError('google-integration-required');
  return sources.map(source =>
    source.kind === 'drive-file'
      ? {
          kind: 'google-drive-file',
          fileId: source.fileId,
          integrationId: integration.id,
          accountId: integration.account_id,
          generation: integration.generation,
        }
      : source,
  );
}

export function createAgentTasks(
  runtime: AgentStorage,
  claimMcpSelection?: (
    tx: AgentTransaction,
    actor: HumanActor,
    input: { selectionId: string; version: number; taskId: string; agentId: string },
  ) => Promise<unknown>,
) {
  runtime = withTaskTelemetry(runtime);
  async function transaction<T>(
    workspaceId: string,
    user: string,
    write: boolean,
    operation: (tx: AgentTransaction & { commonVersion: number }, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      return operation(tx, await resolveHuman(tx, user));
    });
  }
  async function owned(tx: AgentTransaction, actor: HumanActor, id: string) {
    const row = storedSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT ${columns} FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1 AND owner_user_id=$2 AND owner_membership_id=$3`,
            [id, actor.userId, actor.membershipId],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function eligible(tx: AgentTransaction, actor: HumanActor, agentId: string, activationId?: string) {
    await requireTaskInvocation(tx, actor, agentId);
    const rows = z
      .array(
        z.object({
          id: uuidSchema,
          revision: z.string(),
          definition: agentDefinitionSchema,
          scope: scopeSchema,
          activated_at: z.date().nullable(),
        }),
      )
      .parse(
        (
          await tx.client.query(
            `SELECT a.id,a.definition_revision AS revision,d.definition,a.scope,a.activated_at FROM ${relation(tx, 'tf_agent_activations')} a JOIN ${relation(tx, 'tf_agents')} g ON g.id=a.agent_id JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=a.agent_id AND d.revision=a.definition_revision WHERE a.agent_id=$1 AND a.revoked_at IS NULL AND g.enabled AND ($2::uuid IS NULL OR a.id=$2) AND EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_saved_revisions')} s WHERE s.agent_id=a.agent_id AND s.definition_revision=a.definition_revision) ORDER BY a.activated_at DESC NULLS LAST,a.id DESC`,
            [agentId, activationId ?? null],
          )
        ).rows,
      );
    const candidates = [];
    for (const row of rows) {
      try {
        await resolveProcedures(tx, row.definition.skills, actor);
        candidates.push(row);
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
      }
    }
    const selected = candidates[0];
    if (!selected) throw new AccessDenied();
    if (
      !activationId &&
      candidates.length > 1 &&
      (!selected.activated_at || candidates[1]?.activated_at?.getTime() === selected.activated_at.getTime())
    )
      throw new AgentTaskError('activation-selection-required');
    return selected;
  }
  async function sourcesAllowed(
    tx: AgentTransaction,
    actor: HumanActor,
    sources: Sources,
    visited = new Set<string>(),
    depth = 0,
    budget = { remaining: 1000 },
    runId?: string,
  ) {
    if (depth > 8) throw new AgentTaskError('context-limit');
    for (const source of await protectedSourceClosure(tx, sources))
      await requireProtectedSource(tx, actor, source, runId);
    for (const source of sources) {
      if (source.kind === 'table') {
        if (!(await canAccessAsset(tx, actor, source.tableId, 'table.row.read'))) throw new AccessDenied();
        if (runId && !(await canAccessAsset(tx, { kind: 'agent', runId }, source.tableId, 'table.row.read')))
          throw new AccessDenied();
      } else if (source.kind === 'attachment') {
        const allowed = await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_conversation_attachments')} a JOIN ${relation(tx, 'tf_conversations')} c ON c.id=a.conversation_id JOIN ${relation(tx, 'tf_conversation_parts')} p ON p.conversation_id=c.id AND p.message_id=a.message_id AND p.attachment_id=a.id WHERE a.id=$1 AND c.id=$2 AND c.kind='private' AND c.owner_user_id=$3 AND c.owner_membership_id=$4 AND a.state='bound'`,
          [source.attachmentId, source.conversationId, actor.userId, actor.membershipId],
        );
        if (!allowed.rowCount) throw new AccessDenied();
      } else if (source.kind === 'file') {
        // Only the owner's delegated run for this task may read it; a scheduled run has no person whose access applies.
        if (runId) await requireMcpTaskRun(tx, actor, runId);
        const readable = bindFileSources(tx).requireTulipFarmFile;
        if (!readable) throw new AccessDenied();
        await readable(actor, source);
      } else if (source.kind === 'google-drive-file') {
        // Google decides who can open the file; the runtime reads it only through the owner's bound integration, and never for a scheduled run.
        if (runId) await requireMcpTaskRun(tx, actor, runId);
      } else if (source.kind === 'private-task') {
        await requirePrivateTaskSource(tx, actor, source.taskId);
        if (runId) await requireMcpTaskRun(tx, actor, runId);
      } else if (source.kind === 'mcp-integration') {
        if (runId) await requireMcpTaskRun(tx, actor, runId);
        await requireMcpSource(tx, actor, source);
      } else if (source.kind === 'task') {
        const task = await owned(tx, actor, source.taskId);
        await requireTaskInvocation(tx, actor, task.agentId);
        await requireTaskDefinitionSources(tx, actor, source.taskId, runId);
        const key = `${source.taskId}/${source.throughSequence}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sequence=$2`,
              [source.taskId, source.throughSequence],
            )
          ).rowCount
        )
          throw new AccessDenied();
        const githubContext = await githubTaskContext(tx, source.taskId);
        if (source.throughSequence < githubContext.sequence) throw new AccessDenied();
        const messages = z
          .array(z.object({ sources: taskSourcesSchema }))
          .parse(
            (
              await tx.client.query(
                `SELECT sources FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sequence<=$2 AND sequence>=$4 ORDER BY sequence LIMIT $3`,
                [source.taskId, source.throughSequence, budget.remaining + 1, githubContext.sequence],
              )
            ).rows,
          );
        budget.remaining -= messages.length;
        if (budget.remaining < 0) throw new AgentTaskError('context-limit');
        for (const message of messages)
          await sourcesAllowed(tx, actor, message.sources, visited, depth + 1, budget, runId);
      }
    }
  }
  /** New references to other tasks must fit what the runtime reads from one reference; `self` is never read back as a reference. */
  async function referencesFit(tx: AgentTransaction, sources: Sources, self?: string) {
    for (const source of sources) {
      if (source.kind !== 'task' || source.taskId === self) continue;
      const githubContext = await githubTaskContext(tx, source.taskId);
      const count = z
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT count(*)::integer AS count FROM (SELECT 1 FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sequence<=$2 AND sequence>=$3 LIMIT $4) m`,
              [source.taskId, source.throughSequence, githubContext.sequence, taskReferenceMessageLimit + 1],
            )
          ).rows[0]?.count,
        );
      if (count > taskReferenceMessageLimit) throw new AgentTaskError('context-limit');
    }
  }
  async function previous(tx: AgentTransaction, actor: HumanActor, requestId: string, command: unknown) {
    const digest = createHash('sha256').update(canonicalJson(command)).digest('hex');
    const row = z
      .object({ input_digest: z.string(), receipt: taskReceiptSchema })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT input_digest,receipt FROM ${relation(tx, 'tf_agent_task_commands')} WHERE membership_id=$1 AND request_id=$2`,
            [actor.membershipId, requestId],
          )
        ).rows[0],
      );
    if (row && row.input_digest !== digest) throw new AgentTaskError('idempotency-conflict');
    return { digest, receipt: row?.receipt };
  }
  async function saveReceipt(tx: AgentTransaction, actor: HumanActor, requestId: string, digest: string, task: Task) {
    const receipt = taskReceiptSchema.parse(task);
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_task_commands')} (membership_id,request_id,input_digest,receipt) VALUES ($1,$2,$3,$4)`,
      [actor.membershipId, requestId, digest, receipt],
    );
    return receipt;
  }
  async function append(
    tx: AgentTransaction,
    task: Task,
    text: string,
    sources: Sources,
    role: 'owner' | 'agent' = 'owner',
  ) {
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) SELECT $1,COALESCE(max(sequence)+1,0),$2,$3,$4,$5 FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1`,
      [task.id, task.generation, role, text, JSON.stringify(sources)],
    );
    if (role === 'owner' && 'commonVersion' in tx && Number(tx.commonVersion) >= 1)
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_tasks')} SET knowledge_root=jsonb_build_object('kind','task','id',id,'sequence',(SELECT max(sequence) FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1)) WHERE id=$1`,
        [task.id],
      );
  }
  async function requireCapacity(tx: AgentTransaction, actor: HumanActor) {
    const count = z
      .number()
      .parse(
        (
          await tx.client.query(
            `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_agent_tasks')} WHERE owner_membership_id=$1 AND status IN ('pending','waiting-clarification','waiting-approval','paused')`,
            [actor.membershipId],
          )
        ).rows[0]?.count,
      );
    if (count >= 1000) throw new AgentTaskError('task-limit');
  }
  async function admit(tx: AgentTransaction, actor: HumanActor, agentId: string, activationId?: string) {
    await requireCapacity(tx, actor);
    return eligible(tx, actor, agentId, activationId);
  }
  async function clampLimits(tx: AgentTransaction, agentId: string, limits: TaskLimits) {
    const configured = taskLimitsSchema.parse(
      (await tx.client.query(`SELECT task_limits FROM ${relation(tx, 'tf_agent_limits')} WHERE agent_id=$1`, [agentId]))
        .rows[0]?.task_limits ?? maximumTaskLimits,
    );
    return {
      toolCalls: Math.min(limits.toolCalls, configured.toolCalls),
      activeMilliseconds: Math.min(limits.activeMilliseconds, configured.activeMilliseconds),
      credits: Math.min(limits.credits, configured.credits),
    };
  }
  async function insert(
    tx: AgentTransaction,
    actor: HumanActor,
    activation: Awaited<ReturnType<typeof eligible>>,
    input: {
      agentId: string;
      scope: Scope;
      limits: TaskLimits;
      text: string;
      sources: Sources;
      scheduleId: string | null;
      parentTask?: Task;
      delegationTools?: string[];
      flowId?: string;
      /** A chat's sub-agent starts one level below the chat. */
      delegationDepth?: number;
    },
  ) {
    const id = randomUUID();
    // Only a scheduled start names schedule_id, so a workspace still before common migration 0008 can start ordinary tasks.
    const scheduled =
      input.scheduleId === null ? { columns: '', values: '' } : { columns: ',schedule_id', values: ',$14' };
    const inserted = await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,parent_task_id,delegation_depth,delegation_tools,skills,scope,limits,flow_id${scheduled.columns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${scheduled.values})`,
      [
        id,
        actor.userId,
        actor.membershipId,
        input.agentId,
        activation.id,
        activation.revision,
        input.parentTask?.id ?? null,
        input.parentTask ? input.parentTask.delegationDepth + 1 : (input.delegationDepth ?? 0),
        input.delegationTools ? JSON.stringify(input.delegationTools) : null,
        JSON.stringify(activation.definition.skills ?? []),
        JSON.stringify(input.scope),
        input.limits,
        input.flowId ?? id,
        ...(input.scheduleId === null ? [] : [input.scheduleId]),
      ],
    );
    taskTransition(tx, 'started', inserted.rowCount);
    const task = await owned(tx, actor, id);
    await append(tx, task, input.text, input.sources);
    return task;
  }
  /** `inherited` sources come from the server, such as plan results copied into the text, never from the person starting the task. */
  async function start(
    workspaceId: string,
    user: string,
    value: unknown,
    useActivationScope = false,
    inherited: unknown = [],
    guard?: (tx: AgentTransaction) => Promise<void>,
    knowledgeOrigin?: KnowledgeRootOrigin,
    /** A chat sub-agent's tools never exceed the tools its chat is offered. */
    chatTools?: readonly string[],
  ) {
    const input = startTaskSchema.parse(value);
    const carried = taskSourcesSchema.parse(inherited);
    const subagent = knowledgeOrigin?.kind === 'chat-call' && knowledgeOrigin.tool === 'agents.delegate';
    if (
      (knowledgeOrigin &&
        (subagent
          ? !Array.from({ length: subagentLimits.children }, (_, index) =>
              delegatedRequestId(knowledgeOrigin.callId, index),
            ).includes(input.requestId)
          : input.requestId !==
            (knowledgeOrigin.kind === 'chat-call' ? knowledgeOrigin.callId : knowledgeOrigin.attemptId))) ||
      (knowledgeOrigin?.kind === 'chat-call' &&
        ((knowledgeOrigin.tool !== 'agents.task.start' && !subagent) || !knowledgeOrigin.turnId))
    )
      throw new AccessDenied();
    if (input.mcpSelection && !claimMcpSelection) throw new AccessDenied();
    return transaction(workspaceId, user, true, async (tx, actor) => {
      const command = await previous(tx, actor, input.requestId, {
        kind: 'start',
        ...input,
        ...(knowledgeOrigin ? { knowledgeOrigin } : {}),
      });
      if (command.receipt) {
        await owned(tx, actor, command.receipt.id);
        return command.receipt;
      }
      await guard?.(tx);
      const activation = await admit(tx, actor, input.agentId, input.activationId);
      const own = await bindGoogleInputs(tx, actor, input.sources);
      const sources = [...own, ...carried];
      await sourcesAllowed(tx, actor, sources);
      await referencesFit(tx, own);
      const task = await insert(tx, actor, activation, {
        ...input,
        scope: useActivationScope ? activation.scope : input.scope,
        limits: await clampLimits(tx, input.agentId, input.limits),
        sources,
        scheduleId: null,
        ...(subagent
          ? {
              delegationDepth: 1,
              // Selected skills load through skills.read even when the definition does not list it.
              delegationTools: [
                ...new Set([
                  ...activation.definition.tools,
                  ...(activation.definition.skills?.length ? ['skills.read' as const] : []),
                ]),
              ].filter(tool => !chatTools || chatTools.includes(tool)),
            }
          : {}),
      });
      if (tx.commonVersion >= 1 && knowledgeOrigin) {
        const root = await knowledgeRootForRequest(tx, actor, knowledgeOrigin);
        await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_tasks')} SET knowledge_root=$2 WHERE id=$1`, [
          task.id,
          root ? JSON.stringify(root) : null,
        ]);
      }
      if (input.mcpSelection && claimMcpSelection)
        await claimMcpSelection(tx, actor, { ...input.mcpSelection, taskId: task.id, agentId: input.agentId });
      return saveReceipt(tx, actor, input.requestId, command.digest, task);
    });
  }
  async function delegate(
    workspaceId: string,
    user: string,
    parentId: string,
    parentRunId: string,
    requestId: string,
    value: unknown,
  ) {
    parentId = uuidSchema.parse(parentId);
    parentRunId = uuidSchema.parse(parentRunId);
    requestId = uuidSchema.parse(requestId);
    const input = delegatedTaskInputSchema.parse(value);
    return transaction(workspaceId, user, true, async (tx, actor) => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 648291))', [`${tx.schema}:${parentId}`]);
      const parent = await owned(tx, actor, parentId);
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_agent_task_runs')} WHERE task_id=$1 AND run_id=$2 AND generation=$3`,
            [parentId, parentRunId, parent.generation],
          )
        ).rowCount
      )
        throw new AccessDenied();
      const command = await previous(tx, actor, requestId, { kind: 'delegate', parentId, ...input });
      if (command.receipt) {
        const child = await owned(tx, actor, command.receipt.id);
        if (child.parentTaskId !== parent.id) throw new AgentTaskError('idempotency-conflict');
        return command.receipt;
      }
      if (parent.delegationDepth >= maximumDelegationDepth) throw new AgentTaskError('delegation-depth');
      if (parent.status !== 'pending') throw new AgentTaskError('task-not-completed');
      const children = z
        .number()
        .int()
        .parse(
          (
            await tx.client.query(
              `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_agent_tasks')} WHERE parent_task_id=$1`,
              [parentId],
            )
          ).rows[0]?.count,
        );
      if (children >= maximumChildTasks) throw new AgentTaskError('delegation-limit');
      await requireTaskInvocation(tx, actor, parent.agentId);
      const parentDefinition = agentDefinitionSchema.parse(
        (
          await tx.client.query(
            `SELECT definition FROM ${relation(tx, 'tf_agent_definitions')} WHERE agent_id=$1 AND revision=$2`,
            [parent.agentId, parent.definitionRevision],
          )
        ).rows[0]?.definition,
      );
      const parentTools = parent.delegationTools ?? parentDefinition.tools;
      if (!parentTools.includes('agents.task.start')) throw new AccessDenied();
      const activation = await admit(tx, actor, input.agentId, input.activationId);
      const childTools = activation.definition.tools.filter(tool => parentTools.includes(tool));
      const configured = z
        .object({ scope: scopeSchema })
        .optional()
        .parse(
          (
            await tx.client.query(`SELECT scope FROM ${relation(tx, 'tf_agent_limits')} WHERE agent_id=$1`, [
              input.agentId,
            ])
          ).rows[0],
        );
      const parentAuthority = z
        .object({ activation_scope: scopeSchema, limit_scope: scopeSchema })
        .parse(
          (
            await tx.client.query(
              `SELECT a.scope AS activation_scope,l.scope AS limit_scope FROM ${relation(tx, 'tf_agent_activations')} a JOIN ${relation(tx, 'tf_agent_limits')} l ON l.agent_id=a.agent_id WHERE a.id=$1 AND a.agent_id=$2`,
              [parent.activationId, parent.agentId],
            )
          ).rows[0],
        );
      const requestedScope = input.scope ?? parent.scope;
      const scopeMaps = [
        parentAuthority.activation_scope,
        parentAuthority.limit_scope,
        requestedScope,
        activation.scope,
        configured?.scope ?? [],
      ].map(scope => new Map(scope.map(entry => [entry.assetId, new Set(entry.permissions)])));
      const intersected = parent.scope.flatMap(entry => {
        const allowed = entry.permissions.filter(permission =>
          scopeMaps.every(map => map.get(entry.assetId)?.has(permission)),
        );
        return allowed.length ? [{ assetId: entry.assetId, permissions: allowed }] : [];
      });
      const permittedScope = [];
      for (const entry of intersected) {
        const permissions = [];
        for (const permission of entry.permissions)
          if (await canAccessAsset(tx, { kind: 'agent', runId: parentRunId }, entry.assetId, permission))
            permissions.push(permission);
        if (permissions.length) permittedScope.push({ assetId: entry.assetId, permissions });
      }
      const scope = scopeSchema.parse(permittedScope);
      const limits = await clampLimits(tx, input.agentId, input.limits);
      const spent = z
        .object({ amount: z.string() })
        .parse(
          (
            await tx.client.query(
              `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS amount FROM ${relation(tx, 'tf_credit_usage')} WHERE flow_id=$1`,
              [parent.flowId],
            )
          ).rows[0],
        );
      const knowledge = await knowledgeTaskUsage(tx, parent.flowId);
      const spentPico = BigInt(spent.amount) + BigInt(knowledge.known) + BigInt(knowledge.held);
      const creditUnit = 1000000000000n;
      const availableCredits = Number((BigInt(parent.limits.credits) * creditUnit - spentPico) / creditUnit);
      const childCreditBudget = Math.min(limits.credits, availableCredits);
      if (childCreditBudget < 1) throw new AgentTaskError('task-limit');
      const cumulativeCreditLimit = Math.min(parent.limits.credits, Number(spentPico / creditUnit) + childCreditBudget);
      const task = await insert(tx, actor, activation, {
        agentId: input.agentId,
        scope,
        limits: { ...limits, credits: cumulativeCreditLimit },
        text: input.text,
        sources: [
          {
            kind: 'task',
            taskId: parent.id,
            throughSequence: z
              .number()
              .parse(
                (
                  await tx.client.query(
                    `SELECT max(sequence) AS sequence FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1`,
                    [parent.id],
                  )
                ).rows[0]?.sequence,
              ),
          },
        ],
        scheduleId: null,
        parentTask: parent,
        delegationTools: childTools,
        flowId: parent.flowId,
      });
      if (tx.commonVersion >= 1)
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_tasks')} SET knowledge_root=(SELECT knowledge_root FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=$2 AND run_id=$3) WHERE id=$1`,
          [task.id, requestId, parentRunId],
        );
      await append(
        tx,
        parent,
        `Delegated work to saved agent ${input.agentId} in child task ${task.id}.`,
        [{ kind: 'task', taskId: task.id, throughSequence: 0 }],
        'agent',
      );
      return saveReceipt(tx, actor, requestId, command.digest, task);
    });
  }
  async function readResult(workspaceId: string, user: string, id: string, parentId?: string) {
    id = uuidSchema.parse(id);
    if (parentId) parentId = uuidSchema.parse(parentId);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const task = await owned(tx, actor, id);
      if (parentId) {
        const parent = await owned(tx, actor, parentId);
        if (task.parentTaskId !== parent.id || task.delegationDepth !== parent.delegationDepth + 1)
          throw new AccessDenied();
        await requireTaskInvocation(tx, actor, parent.agentId);
      }
      await requireTaskInvocation(tx, actor, task.agentId);
      await requireTaskDefinitionSources(tx, actor, id);
      await retainedSources(tx, actor, id);
      const latest =
        task.status === 'completed'
          ? taskMessageSchema
              .optional()
              .parse(
                (
                  await tx.client.query(
                    `SELECT sequence,generation,role,text,sources,created_at::text AS "createdAt" FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND role='agent' ORDER BY sequence DESC LIMIT 1`,
                    [id],
                  )
                ).rows[0],
              )
          : undefined;
      if (latest) await sourcesAllowed(tx, actor, latest.sources);
      return { taskId: id, status: task.status, ...(latest ? { result: latest.text } : {}) };
    });
  }
  /** Starts a schedule's task as its sponsor; the schedule's occurrence is the request, so no idempotency receipt is kept. */
  async function startScheduled(workspaceId: string, user: string, value: unknown) {
    const input = scheduledTaskSchema.parse(value);
    return transaction(workspaceId, user, true, async (tx, actor) => {
      const activation = await admit(tx, actor, input.agentId, input.activationId);
      return taskReceiptSchema.parse(
        await insert(tx, actor, activation, {
          ...input,
          limits: await clampLimits(tx, input.agentId, input.limits),
          sources: [],
        }),
      );
    });
  }
  async function reopen(workspaceId: string, user: string, id: string, value: unknown) {
    id = uuidSchema.parse(id);
    const input = reopenTaskSchema.parse(value);
    return transaction(workspaceId, user, true, async (tx, actor) => {
      const task = await owned(tx, actor, id);
      const command = await previous(tx, actor, input.requestId, { kind: 'reopen', id, ...input });
      if (command.receipt) return command.receipt;
      if (task.generation !== input.expectedGeneration) throw new AgentTaskError('generation-conflict');
      if (task.status !== 'completed') throw new AgentTaskError('task-not-completed');
      await admit(tx, actor, task.agentId, task.activationId);
      const limits = await clampLimits(tx, task.agentId, task.limits);
      const last = z
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT max(sequence) AS sequence FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1`,
              [id],
            )
          ).rows[0]?.sequence,
        );
      const sources = await bindGoogleInputs(tx, actor, input.sources);
      await sourcesAllowed(tx, actor, [{ kind: 'task', taskId: id, throughSequence: last }, ...sources]);
      await referencesFit(tx, sources, id);
      const changed = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_tasks')} SET generation=generation+1,status='pending',limits=$2 WHERE id=$1 AND status IS DISTINCT FROM 'pending'`,
        [id, limits],
      );
      taskTransition(tx, 'started', changed.rowCount);
      const reopened = await owned(tx, actor, id);
      await append(tx, reopened, input.text, sources);
      return saveReceipt(tx, actor, input.requestId, command.digest, reopened);
    });
  }
  async function summary(tx: AgentTransaction, task: Task) {
    const cost = (
      await tx.client.query(
        `SELECT COALESCE(sum(charged),0)::text AS "chargedCreditUnits",COALESCE(sum(reserved) FILTER (WHERE charged IS NULL),0)::text AS "heldCreditUnits" FROM ${relation(tx, 'tf_credit_usage')} WHERE flow_id=$1`,
        [task.flowId],
      )
    ).rows[0];
    const knowledge = await knowledgeTaskUsage(tx, task.flowId);
    return taskSummarySchema.parse({
      ...task,
      cost: {
        chargedCreditUnits: (BigInt(cost.chargedCreditUnits) + knowledge.known).toString(),
        heldCreditUnits: (BigInt(cost.heldCreditUnits) + knowledge.held).toString(),
      },
    });
  }
  async function continueTask(workspaceId: string, user: string, id: string, value: unknown) {
    id = uuidSchema.parse(id);
    const input = continueTaskSchema.parse(value);
    return transaction(workspaceId, user, true, async (tx, actor) => {
      const task = await owned(tx, actor, id);
      const command = await previous(tx, actor, input.requestId, { kind: 'continue', id, ...input });
      if (command.receipt) return command.receipt;
      const sequence = z
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT max(sequence) AS sequence FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1`,
              [id],
            )
          ).rows[0]?.sequence,
        );
      if (
        task.generation !== input.expectedGeneration ||
        sequence !== input.expectedSequence ||
        !['waiting-clarification', 'paused', 'failed'].includes(task.status)
      )
        throw new AgentTaskError('continuation-conflict');
      if (
        (
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_agent_task_activity')} WHERE task_id=$1 AND status='running' AND expires_at>clock_timestamp() UNION ALL SELECT 1 FROM ${relation(tx, 'tf_model_attempts')} a JOIN ${relation(tx, 'tf_agent_task_runs')} b ON b.run_id=a.run_id WHERE b.task_id=$1 AND a.status='running' AND a.lease_until>clock_timestamp()`,
            [id],
          )
        ).rowCount
      )
        throw new AgentTaskError('continuation-conflict');
      if (task.status === 'failed') await requireCapacity(tx, actor);
      await eligible(tx, actor, task.agentId, task.activationId);
      const sources = await bindGoogleInputs(tx, actor, input.sources);
      await sourcesAllowed(tx, actor, [{ kind: 'task', taskId: id, throughSequence: sequence }, ...sources]);
      await referencesFit(tx, sources, id);
      if (
        input.limits &&
        (input.limits.toolCalls < task.limits.toolCalls ||
          input.limits.activeMilliseconds < task.limits.activeMilliseconds ||
          input.limits.credits < task.limits.credits)
      )
        throw new AgentTaskError('continuation-conflict');
      const limits = await clampLimits(tx, task.agentId, input.limits ?? task.limits);
      const changed = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status='pending',limits=$2 WHERE id=$1 AND status IS DISTINCT FROM 'pending'`,
        [id, limits],
      );
      taskTransition(tx, 'started', changed.rowCount);
      await append(tx, task, input.text, sources);
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_task_steps')} s SET completed=true WHERE task_id=$1 AND generation=$2 AND NOT completed AND (decision->>'kind'='clarify' OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_model_generations')} g WHERE g.run_id=s.run_id AND g.generation=s.step AND g.status='failed'))`,
        [id, task.generation],
      );
      return saveReceipt(tx, actor, input.requestId, command.digest, await owned(tx, actor, id));
    });
  }
  async function read(workspaceId: string, user: string, id: string) {
    id = uuidSchema.parse(id);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const task = await owned(tx, actor, id);
      await retainedSources(tx, actor, id);
      const value = await summary(tx, task);
      if (
        !(await tx.client.query('SELECT to_regclass($1) AS name', [relation(tx, 'tf_agent_task_runs')])).rows[0]?.name
      )
        return value;
      const calls = (
        await tx.client.query(
          `SELECT c.id,c.call,c.status,c.result FROM ${relation(tx, 'tf_agent_tool_calls')} c JOIN ${relation(tx, 'tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 AND b.generation=$2 ORDER BY c.sequence LIMIT 1000`,
          [id, task.generation],
        )
      ).rows;
      const activityInstalled = (
        await tx.client.query('SELECT to_regclass($1) AS name', [relation(tx, 'tf_agent_task_activity')])
      ).rows[0]?.name;
      const active =
        activityInstalled &&
        !!(
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_agent_task_activity')} WHERE task_id=$1 AND kind='tool' AND status='running' AND expires_at>clock_timestamp()`,
            [id],
          )
        ).rowCount;
      const current = calls.find(row => row.status === 'pending' || row.status === 'waiting');
      for (const row of calls) {
        const call = z.object({ tool: z.string() }).parse(row.call);
        const status =
          active && current === row && !['mcp.call', 'github.personal.propose'].includes(call.tool)
            ? 'running'
            : await storedToolStatus(tx, { id: row.id, tool: call.tool, status: row.status, output: row.result });
        value.activity.push(
          activityReceiptSchema.parse({
            id: row.id,
            tool: call.tool,
            status: task.status === 'failed' && (status === 'running' || status === 'queued') ? 'failed' : status,
            presentation: await storedToolPresentation(tx, actor, call.tool, row.call, undefined, row.id),
          }),
        );
      }
      return value;
    });
  }
  async function pause(workspaceId: string, user: string, id: string, value: unknown) {
    const input = z.strictObject({ expectedGeneration: z.number().int().nonnegative() }).parse(value);
    return transaction(workspaceId, user, true, async (tx, actor) => {
      const task = await owned(tx, actor, uuidSchema.parse(id));
      if (task.generation !== input.expectedGeneration) throw new AgentTaskError('generation-conflict');
      if (task.status === 'failed') await requireCapacity(tx, actor);
      const changed = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status='paused',pause_reason='user' WHERE id=$1 AND status<>'completed' AND status IS DISTINCT FROM 'paused'`,
        [id],
      );
      taskTransition(tx, 'paused', changed.rowCount);
      return taskReceiptSchema.parse(await owned(tx, actor, id));
    });
  }
  async function retainedSources(tx: AgentTransaction, actor: HumanActor, id: string) {
    const row = (
      await tx.client.query(
        `SELECT max(sequence) AS sequence FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1`,
        [id],
      )
    ).rows[0];
    if (row?.sequence === null) return;
    const retained = await protectedSourceClosure(tx, [{ kind: 'task', taskId: id, throughSequence: row?.sequence }]);
    if (
      !retained.some(
        source =>
          source.kind === 'mcp-integration' ||
          source.kind === 'github-personal' ||
          (source.kind === 'github-source' && source.investigation),
      )
    )
      return;
    for (const source of retained) await requireProtectedSource(tx, actor, source);
  }
  async function list(workspaceId: string, user: string, value: unknown = {}) {
    const query = taskListQuerySchema.parse(value);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const rows = z
        .array(storedSchema)
        .parse(
          (
            await tx.client.query(
              `SELECT ${columns} FROM ${relation(tx, 'tf_agent_tasks')} WHERE owner_user_id=$1 AND owner_membership_id=$2 AND ($3::uuid IS NULL OR id>$3) AND (NOT $5::boolean OR status NOT IN ('completed','failed')) ORDER BY id LIMIT $4`,
              [
                actor.userId,
                actor.membershipId,
                query.after ?? null,
                query.search ? 1000 : query.limit + 1,
                query.state === 'active',
              ],
            )
          ).rows,
        );
      const matched = [];
      for (const row of rows) {
        try {
          await retainedSources(tx, actor, row.id);
        } catch (error) {
          if (error instanceof AccessDenied) continue;
          throw error;
        }
        if (query.search) {
          try {
            await requireTaskInvocation(tx, actor, row.agentId);
            await requireTaskDefinitionSources(tx, actor, row.id);
            const first = taskMessageSchema
              .optional()
              .parse(
                (
                  await tx.client.query(
                    `SELECT sequence,generation,role,text,sources,created_at::text AS "createdAt" FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 ORDER BY sequence LIMIT 1`,
                    [row.id],
                  )
                ).rows[0],
              );
            if (!first) continue;
            await sourcesAllowed(tx, actor, first.sources);
            if (!first.text.toLowerCase().includes(query.search.toLowerCase())) continue;
          } catch (error) {
            if (error instanceof AccessDenied) continue;
            throw error;
          }
        }
        matched.push(row);
        if (matched.length > query.limit) break;
      }
      const tasks = [];
      for (const row of matched.slice(0, query.limit)) tasks.push(await summary(tx, row));
      return {
        tasks,
        nextCursor:
          matched.length > query.limit
            ? (tasks.at(-1)?.id ?? null)
            : !query.search && rows.length > query.limit
              ? (rows.at(-1)?.id ?? null)
              : null,
      };
    });
  }
  async function history(workspaceId: string, user: string, id: string, value: unknown = {}) {
    id = uuidSchema.parse(id);
    const query = taskHistoryQuerySchema.parse(value);
    return transaction(workspaceId, user, false, (tx, actor) => readHistory(tx, actor, id, query));
  }
  async function readHistory(
    tx: AgentTransaction,
    actor: HumanActor,
    id: string,
    query: z.infer<typeof taskHistoryQuerySchema>,
  ) {
    const task = await owned(tx, actor, id);
    await requireTaskInvocation(tx, actor, task.agentId);
    await requireTaskDefinitionSources(tx, actor, id);
    await retainedSources(tx, actor, id);
    const githubContext = await githubTaskContext(tx, id);
    const rows = z
      .array(taskMessageSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT sequence,generation,role,text,sources,created_at::text AS "createdAt" FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`,
            [id, Math.max(query.after, githubContext.sequence - 1), query.limit + 1],
          )
        ).rows,
      );
    const messages = rows.slice(0, query.limit);
    for (const message of messages) await sourcesAllowed(tx, actor, message.sources);
    return { messages, nextCursor: rows.length > query.limit ? (messages.at(-1)?.sequence ?? null) : null };
  }
  async function recent(workspaceId: string, user: string) {
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const tasks = relation(tx, 'tf_agent_tasks');
      const titles = new Map<string, string>();
      const page = await visiblePage(
        { limit: 3 },
        async (after, limit) =>
          z.array(z.object({ id: uuidSchema })).parse(
            (
              await tx.client.query(
                `SELECT id FROM ${tasks} WHERE owner_user_id=$1 AND owner_membership_id=$2
         AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM ${tasks} WHERE id=$3 AND owner_user_id=$1 AND owner_membership_id=$2))
         ORDER BY created_at DESC,id DESC LIMIT $4`,
                [actor.userId, actor.membershipId, after ?? null, limit],
              )
            ).rows,
          ),
        async item => {
          const history = await readHistory(tx, actor, item.id, { after: -1, limit: 25 });
          const text =
            history.messages
              .find(message => message.role === 'owner')
              ?.text.replace(/\s+/g, ' ')
              .trim() || 'Private task';
          titles.set(item.id, text.length > 160 ? `${text.slice(0, 157)}...` : text);
        },
      );
      return page.items.map(item => ({ id: item.id, name: z.string().parse(titles.get(item.id)) }));
    });
  }
  async function attachment(workspaceId: string, user: string, id: string, attachmentId: string) {
    id = uuidSchema.parse(id);
    attachmentId = uuidSchema.parse(attachmentId);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      const task = await owned(tx, actor, id);
      await requireTaskInvocation(tx, actor, task.agentId);
      await retainedSources(tx, actor, id);
      const rows = z
        .array(z.object({ sources: taskSourcesSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT sources FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1 AND sources @> $2::jsonb LIMIT 1`,
              [id, JSON.stringify([{ kind: 'attachment', attachmentId }])],
            )
          ).rows,
        );
      const source = rows[0]?.sources.find(
        source => source.kind === 'attachment' && source.attachmentId === attachmentId,
      );
      if (!source || source.kind !== 'attachment') throw new AccessDenied();
      await sourcesAllowed(tx, actor, [source]);
      return source;
    });
  }
  /** Whether a reader other than the owner may see a task's result: every source its agent messages retained must be readable to them. */
  async function resultReadable(tx: AgentTransaction, actor: HumanActor, id: string) {
    const sources = z
      .array(taskSourceSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT COALESCE(jsonb_agg(DISTINCT source),'[]'::jsonb) AS sources FROM ${relation(tx, 'tf_agent_task_messages')} m CROSS JOIN LATERAL jsonb_array_elements(m.sources) source WHERE task_id=$1 AND role='agent'`,
            [uuidSchema.parse(id)],
          )
        ).rows[0]?.sources,
      );
    if (sources.length > 1000) return false;
    try {
      await sourcesAllowed(tx, actor, sources);
      return true;
    } catch (error) {
      if (error instanceof AccessDenied || error instanceof AgentTaskError) return false;
      throw error;
    }
  }
  async function checkSources(workspaceId: string, user: string, value: unknown, runId: string) {
    runId = uuidSchema.parse(runId);
    const sources = taskSourcesSchema.parse(value);
    return transaction(workspaceId, user, false, async (tx, actor) => {
      await requireCurrentActor(tx, { kind: 'agent', runId });
      return sourcesAllowed(tx, actor, sources, new Set(), 0, { remaining: 1000 }, runId);
    });
  }
  /** Throws unless `actor` may read every source, including table grants and private tasks. */
  const requireSources = (tx: AgentTransaction, actor: HumanActor, value: unknown) =>
    sourcesAllowed(tx, actor, taskSourcesSchema.parse(value));
  return {
    start,
    delegate,
    readResult,
    requireSources,
    startForWorkflow: (
      workspaceId: string,
      user: string,
      value: unknown,
      inherited: unknown = [],
      guard?: (tx: AgentTransaction) => Promise<void>,
      knowledgeOrigin?: KnowledgeRootOrigin,
    ) => start(workspaceId, user, value, true, inherited, guard, knowledgeOrigin),
    startScheduled,
    reopen,
    continueTask,
    pause,
    read,
    list,
    recent,
    history,
    attachment,
    checkSources,
    resultReadable,
  };
}
