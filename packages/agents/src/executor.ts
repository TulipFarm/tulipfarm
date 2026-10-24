import { z } from 'zod';
import { errorType, log, observeTool, type ToolRuntime } from '@tulipfarm/observability';
import { requireAgentRunHistory } from '@tulipfarm/access';
import {
  AccessDenied,
  canAccessAsset,
  canAccessTable,
  currentMember,
  lockAuthorization,
  protectedSourceClosure,
  requireTablePermission,
  withMcpSourceContext,
  type Actor,
  type HumanActor,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { IntegrationError, type IntegrationService } from '@tulipfarm/integrations';
import { createAgentRecordTools, markAgentRecordResult } from './record-tools.ts';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { TableValidationError } from '@tulipfarm/tables/definition';
import { GenerationError } from '@tulipfarm/tables/store';
import { WorkspaceMemberError } from '@tulipfarm/tables/workspace-members';
import {
  agentDefinitionSchema,
  executionIdsSchema,
  recordConflict,
  toolCallSchema,
  toolNameSchema,
  toolResultSchema,
  type ExecutionIds,
  type ExecutionStatus,
  type ToolCall,
} from './contracts.ts';
import { agentCompatibility, createAgentStore, relation, type AgentStorage } from './store.ts';
import { createToolRegistry } from './registry.ts';
import { requireHumanRun } from './internal-privacy.ts';
import { requireExternalRun, type ExternalRunGuard } from './external-run.ts';
import { listSkills, readSkill } from './skills.ts';
import { fetchPublicText, searchPublicWeb } from './web-fetch.ts';
import { resolveRunProcedure, resolveRunProcedures } from './workspace-skills.ts';
import {
  admitTaskCall,
  executeTaskCall,
  taskActionEligibility,
  taskRun,
  lockTask,
  taskOutputAllowed,
  boundRuntime,
} from './task-approval-gate.ts';
import { TaskApprovalError } from './task-approval-contracts.ts';
import {
  invokeGoogleTool,
  requireGoogleAgentOwner,
  googleToolError,
  type GoogleOperationsFactory,
} from './google-tools.ts';
import { GoogleOperationError } from '@tulipfarm/google-workspace/operation-contracts';
import { GoogleWorkspaceError } from '@tulipfarm/google-workspace/contracts';
import { GoogleLifecycleError } from '@tulipfarm/google-workspace/operations';
import { googleToolErrorSchema } from './google-tool-contracts.ts';
import { providerSources, queryTargetTables, resultSources } from './tool-sources.ts';
import { sourceDependenciesSchema, type SourceDependency } from '@tulipfarm/access';
import { createIntegrationService, integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { SlackActionsFactory } from './slack-actions.ts';
import { activeTaskWork, reserveTaskWork, withTaskWork, type TaskWork } from './task-activity.ts';
import { isMcpCall } from './mcp-contracts.ts';
import type { McpExecutionFactory } from './mcp-runtime.ts';
import { taskMcpSources, authorizeMcpSources } from './mcp-authority.ts';
import { githubTaskResultSchema, isGitHubTaskCall } from './github-task-contracts.ts';
import { requireInvestigationToolBoundary } from './investigation-boundary.ts';
import { taskGitHubWaiting, type GitHubTaskFactory } from './github-tasks.ts';
import { requireDraftSources } from './draft-sources.ts';
import {
  knowledgeCallUsesQuery,
  knowledgeToolResultSchema,
  knowledgeToolsUnavailable,
} from './knowledge-tool-contracts.ts';
import { readOnlyTools, toolObservation, type KnowledgeToolsFactory } from './tools.ts';
import { invokeBoundedKnowledge, withKnowledgeRetrieveGrant } from './knowledge-retrieval.ts';
import { knowledgeTaskSpend } from '@tulipfarm/workspace-storage/knowledge-credits';
import { createAgentTasks } from './tasks.ts';
import { withTaskTelemetry } from './task-telemetry.ts';
import type { SkillExecutionFactory } from './skill-execution.ts';
import { skillExecutionResultSchema } from './skill-execution-contracts.ts';
import { imageGenerationOffered } from './image-generation.ts';
import {
  generateImageOutputs,
  type ImageGenerator,
  type ImageModelChoice,
  type ImageOutputStore,
} from '@tulipfarm/conversations/image-outputs';

export { createAgentStore } from './store.ts';
export { toolCallSchema, executionIdsSchema } from './contracts.ts';

type Runtime = AgentStorage;
type Transaction = Parameters<Parameters<Runtime['transaction']>[2]>[0];
type Options = {
  runtime: Runtime;
  telemetryRuntime?: ToolRuntime;
  skills?: SkillExecutionFactory | undefined;
  github?: GitHubTaskFactory | undefined;
  mcp?: McpExecutionFactory | undefined;
  integrations?: Pick<IntegrationService, 'readIssue'>;
  google?: GoogleOperationsFactory;
  slack?: SlackActionsFactory | undefined;
  externalGuard?: ExternalRunGuard | undefined;
  internalActivity?: (transaction: Transaction, ids: ExecutionIds) => Promise<void>;
  knowledge?: KnowledgeToolsFactory | undefined;
  /** Generates images for `images.generate` in runs; without it, the call is refused. */
  images?: RunImages | undefined;
};
/** What runs generate images with. The model is the one pinned on the run at admission. */
export type RunImages = {
  files: ImageOutputStore;
  choose(tx: Transaction, runId: string): Promise<{ model: ImageModelChoice; generate: ImageGenerator }>;
};
const callRowSchema = z.object({
  id: z.uuid(),
  run_id: z.uuid(),
  sequence: z.number().int(),
  call: toolCallSchema,
  status: z.enum(['pending', 'completed', 'waiting', 'blocked', 'failed']),
  result: toolResultSchema,
});
const runRowSchema = z.object({
  agent_id: z.uuid(),
  definition_revision: z.string(),
  membership_id: z.uuid().nullable(),
  user_id: z.string().nullable(),
  kind: z.enum(['delegated', 'scheduled']),
  status: z.string(),
});
const githubTaskHandoffs = {
  'selection-required': {
    status: 'waiting-clarification',
    text: 'Choose a GitHub source in this task, then continue. Investigation sources stay private and read-only.',
  },
  'tool-limit': {
    status: 'paused',
    text: 'The task reached its tool limit before every approved GitHub change ran. Increase the tool limit before the approved batch expires to run the remaining changes.',
  },
} as const;

async function requireIssueAccess(
  transaction: AuthorizationTransaction,
  actor: Actor,
  call: Extract<ToolCall, { tool: 'github.issue.read' }>,
) {
  for (const permission of ['integration.read', 'integration.use'] as const)
    if (!(await canAccessAsset(transaction, actor, call.integrationId, permission))) throw new AccessDenied();
  if (!(await canAccessAsset(transaction, actor, call.sourceId, 'github.issue.read'))) throw new AccessDenied();
  const source = await transaction.client.query(
    `SELECT 1 FROM ${relation(transaction, 'tf_integration_sources')} s JOIN ${relation(transaction, 'tf_integrations')} c ON c.id = s.integration_id WHERE c.id = $1 AND s.id = $2 AND c.enabled AND c.deleted_at IS NULL`,
    [call.integrationId, call.sourceId],
  );
  if (!source.rowCount) throw new AccessDenied();
}

export function createAgentExecutor(options: Options) {
  const runtime = withTaskTelemetry(options.runtime);
  const store = createAgentStore(runtime, options.externalGuard);
  async function captureExternalSources(tx: Transaction, ids: ExecutionIds, actor: HumanActor, call: ToolCall) {
    if (
      !(await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_slack_agent_turns')} WHERE run_id=$1`, [ids.runId]))
        .rowCount
    )
      return;
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_slack_tool_sources')} (call_id,sources) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [ids.callId, JSON.stringify(await providerSources(tx, actor, call))],
    );
  }

  async function executionTransaction<T>(
    ids: ExecutionIds,
    operation: (tx: Transaction) => Promise<T>,
    publish = true,
    parallel = false,
  ): Promise<T> {
    return runtime.transaction(ids.workspaceId, agentCompatibility, async tx => {
      await lockAuthorization(tx, options.mcp ? 'write' : 'read');
      const binding = await taskRun(tx, ids.runId);
      if (binding && !parallel) await lockTask(tx, binding.task_id);
      await tx.client.query(
        `SELECT id FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1${parallel ? '' : ' FOR UPDATE'}`,
        [ids.runId],
      );
      if (!options.internalActivity) await requireHumanRun(tx, ids.runId);
      const result = await operation(tx);
      if (publish) await options.internalActivity?.(tx, ids);
      return result;
    });
  }

  async function execute(input: ExecutionIds, batch?: { work: TaskWork }): Promise<ExecutionStatus> {
    const parsed = executionIdsSchema.safeParse(input);
    if (!parsed.success) return 'failed';
    const call = await runtime
      .transaction(parsed.data.workspaceId, agentCompatibility, async tx => {
        const row = (
          await tx.client.query(`SELECT call FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=$1 AND run_id=$2`, [
            parsed.data.callId,
            parsed.data.runId,
          ])
        ).rows[0];
        return toolCallSchema.optional().parse(row?.call);
      })
      .catch(() => undefined);
    if (!call) return perform(input, batch);
    let observation: ReturnType<typeof toolObservation> = { outcome: 'error' };
    let failure: string | undefined;
    return observeTool(
      call.tool,
      options.telemetryRuntime ?? 'agent',
      async () => {
        const status = await perform(input, batch, type => {
          failure = type;
        });
        observation = { outcome: status === 'completed' ? 'success' : status === 'failed' ? 'error' : status };
        if (status === 'completed' || status === 'failed' || status === 'blocked') {
          const result = await runtime
            .transaction(
              parsed.data.workspaceId,
              agentCompatibility,
              async tx =>
                (
                  await tx.client.query(
                    `SELECT result FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=$1 AND run_id=$2`,
                    [parsed.data.callId, parsed.data.runId],
                  )
                ).rows[0]?.result,
            )
            .catch(error => {
              log('warn', 'dependency', 'call_failed', {
                operation: 'tool-telemetry-result',
                'error.type': errorType(error),
              });
              return undefined;
            });
          const reported = toolObservation(result, call.tool);
          observation =
            status === 'completed'
              ? reported
              : { ...reported, outcome: observation.outcome, ...(failure ? { errorType: failure } : {}) };
        }
        return status;
      },
      () => observation,
    );
  }

  /** `failed` receives a caught failure for the caller's tool log; without it, this function logs the failure itself. */
  async function perform(
    input: ExecutionIds,
    batch?: { work: TaskWork },
    failed?: (type: string) => void,
  ): Promise<ExecutionStatus> {
    const parsed = executionIdsSchema.safeParse(input);
    if (!parsed.success) return 'failed';
    const ids = parsed.data;
    return withTaskWork(
      operation => executionTransaction(ids, operation),
      async work => {
        try {
          const admitted = await work.admit(() =>
            executionTransaction(
              ids,
              async tx => {
                const binding = await taskRun(tx, ids.runId);
                if (!binding) return 'legacy';
                const row = callRowSchema
                  .optional()
                  .parse(
                    (
                      await tx.client.query(
                        `SELECT * FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=$1 AND run_id=$2`,
                        [ids.callId, ids.runId],
                      )
                    ).rows[0],
                  );
                if (!row) throw new AccessDenied();
                if (['completed', 'failed', 'blocked'].includes(row.status)) return 'legacy';
                if (row.call.tool === 'github.personal.propose' && (await taskGitHubWaiting(tx, ids.callId)))
                  return null;
                if (
                  row.call.tool === 'mcp.call' &&
                  (
                    await tx.client.query(
                      `SELECT 1 FROM ${relation(tx, 'tf_mcp_actions')} a LEFT JOIN ${relation(tx, 'tf_mcp_claims')} c ON c.action_id=a.id LEFT JOIN ${relation(tx, 'tf_mcp_receipts')} r ON r.action_id=a.id WHERE a.id=$1 AND ((c.action_id IS NULL AND a.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_mcp_decisions')} d WHERE d.action_id=a.id) AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_mcp_policy_evaluations')} p WHERE p.action_id=a.id) AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_mcp_cancellations')} x WHERE x.action_id=a.id)) OR (r.status='outcome-unknown' AND NOT EXISTS(SELECT 1 FROM ${relation(tx, 'tf_mcp_reconciliations')} x WHERE x.action_id=a.id AND x.observation<>'still-unknown')) OR (c.deadline>clock_timestamp() AND r.action_id IS NULL))`,
                      [ids.callId],
                    )
                  ).rowCount
                )
                  return null;
                const owner = await taskOutputAllowed(tx, ids.workspaceId, ids.runId, true);
                if (
                  (
                    await tx.client.query(
                      `SELECT 1 FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status<>'completed'`,
                      [ids.runId, row.sequence],
                    )
                  ).rowCount &&
                  row.call.tool.startsWith('slack.')
                )
                  return null;
                if (
                  row.call.tool.startsWith('slack.') &&
                  (
                    await tx.client.query(
                      `SELECT 1 FROM ${relation(tx, 'tf_slack_actions')} a JOIN ${relation(tx, 'tf_slack_action_effects')} e ON e.action_id=a.id LEFT JOIN ${relation(tx, 'tf_slack_action_decisions')} d ON d.action_id=a.id WHERE a.id=$1 AND a.expires_at>clock_timestamp() AND ((e.state='pending' AND a.approval_required AND d.decision IS NULL) OR (e.state IN ('retry','sending') AND e.next_attempt_at>clock_timestamp()))`,
                      [ids.callId],
                    )
                  ).rowCount
                )
                  return null;
                if (
                  ['rows.create', 'rows.update', 'rows.delete'].includes(row.call.tool) &&
                  typeof (await taskActionEligibility(tx, owner, ids.runId, ids.callId, row.call, false)) === 'string'
                )
                  return null;
                if (
                  (
                    await tx.client.query(
                      `SELECT 1 FROM ${relation(tx, 'tf_model_attempts')} WHERE run_id=$1 AND status='running' AND lease_until>clock_timestamp()`,
                      [ids.runId],
                    )
                  ).rowCount
                )
                  return null;
                if (batch) {
                  if (
                    !(await batch.work.live(tx, binding.task_id)) ||
                    !(
                      await tx.client.query(
                        `SELECT 1 FROM ${relation(tx, 'tf_agent_task_tool_usage')} WHERE task_id=$1 AND call_id=$2`,
                        [binding.task_id, ids.callId],
                      )
                    ).rowCount
                  )
                    return null;
                  return batch.work;
                }
                if (await activeTaskWork(tx, binding.task_id)) return null;
                if (!(await admitTaskCall(tx, binding.task_id, ids.callId))) return null;
                return reserveTaskWork(tx, binding.task_id, 'tool');
              },
              false,
              Boolean(batch),
            ),
          );
          if (!admitted) return 'waiting';
          const outcome = await executionTransaction(
            ids,
            async transaction => {
              if (!(await work.live(transaction))) return 'waiting';
              const executeCall = async () => {
                await lockAuthorization(transaction);
                const run = runRowSchema
                  .optional()
                  .parse(
                    (
                      await transaction.client.query(
                        `SELECT * FROM ${relation(transaction, 'tf_agent_runs')} WHERE id = $1${batch ? '' : ' FOR UPDATE'}`,
                        [ids.runId],
                      )
                    ).rows[0],
                  );
                if (!run || !['ready', 'running', 'waiting'].includes(run.status)) throw new AccessDenied();
                const row = callRowSchema
                  .optional()
                  .parse(
                    (
                      await transaction.client.query(
                        `SELECT * FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE id = $1 AND run_id = $2 FOR UPDATE`,
                        [ids.callId, ids.runId],
                      )
                    ).rows[0],
                  );
                if (!row) throw new AccessDenied();
                const definition = agentDefinitionSchema.parse(
                  (
                    await transaction.client.query(
                      `SELECT definition FROM ${relation(transaction, 'tf_agent_definitions')} WHERE agent_id = $1 AND revision = $2`,
                      [run.agent_id, run.definition_revision],
                    )
                  ).rows[0]?.definition,
                );
                const binding = await taskRun(transaction, ids.runId);
                const delegationTools = binding
                  ? z
                      .array(toolNameSchema)
                      .nullable()
                      .parse(
                        (
                          await transaction.client.query(
                            `SELECT delegation_tools FROM ${relation(transaction, 'tf_agent_tasks')} WHERE id=$1`,
                            [binding.task_id],
                          )
                        ).rows[0]?.delegation_tools ?? null,
                      )
                  : null;
                const automaticSkillRead = row.call.tool === 'skills.read' && (definition.skills?.length ?? 0) > 0;
                if (isMcpCall(row.call)) {
                  if (!definition.mcp?.length || delegationTools !== null) throw new AccessDenied();
                } else if (
                  !withKnowledgeRetrieveGrant(
                    definition.tools.filter(tool => delegationTools === null || delegationTools.includes(tool)),
                  ).includes(row.call.tool) &&
                  !automaticSkillRead
                )
                  throw new AccessDenied();
                if (automaticSkillRead && delegationTools !== null && !delegationTools.includes('skills.read'))
                  throw new AccessDenied();
                if (row.call.tool === 'skills.read') {
                  const { skillId } = row.call;
                  const selected = definition.skills?.find(selection => selection.id === skillId);
                  if (automaticSkillRead && (!selected || selected.revision !== row.call.revision))
                    throw new AccessDenied();
                  if (
                    z.uuid().safeParse(row.call.skillId).success &&
                    (!selected || selected.revision !== row.call.revision)
                  )
                    throw new AccessDenied();
                  if (selected && row.call.revision !== undefined && selected.revision !== row.call.revision)
                    throw new AccessDenied();
                  if (z.uuid().safeParse(row.call.skillId).success && !/^[a-f0-9]{64}$/.test(row.call.revision ?? ''))
                    throw new AccessDenied();
                }
                const actor: Actor = { kind: 'agent', runId: ids.runId };
                await requireExternalRun(transaction, ids.workspaceId, ids.runId, options.externalGuard);
                const procedures = await resolveRunProcedures(transaction, ids.runId);
                const taskAssociated = await executeTaskCall(
                  transaction,
                  ids.workspaceId,
                  ids.runId,
                  ids.callId,
                  row.call,
                  row.status === 'completed',
                  work.reserved ? work : null,
                  Boolean(batch),
                );
                if (typeof taskAssociated === 'string') return taskAssociated;
                if (row.call.tool === 'agents.task.start' || row.call.tool === 'agents.task.read') {
                  if (!binding || run.kind !== 'delegated' || !run.user_id || !run.membership_id)
                    throw new AccessDenied();
                  if (row.status === 'completed') return 'completed';
                  if (row.status === 'failed' || row.status === 'blocked') return row.status;
                  if (
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status<>'completed' LIMIT 1`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  const local = boundRuntime(transaction, ids.workspaceId);
                  const tasks = createAgentTasks(local);
                  let output: unknown;
                  if (row.call.tool === 'agents.task.start') {
                    const result = await tasks.delegate(
                      ids.workspaceId,
                      run.user_id,
                      binding.task_id,
                      ids.runId,
                      ids.callId,
                      {
                        agentId: row.call.agentId,
                        ...(row.call.activationId ? { activationId: row.call.activationId } : {}),
                        ...(row.call.scope ? { scope: row.call.scope } : {}),
                        limits: row.call.limits,
                        text: row.call.text,
                      },
                    );
                    output = { taskId: result.id, status: result.status };
                  } else {
                    output = await tasks.readResult(ids.workspaceId, run.user_id, row.call.taskId, binding.task_id);
                  }
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='completed',result=$2 WHERE id=$1`,
                    [ids.callId, JSON.stringify(toolResultSchema.parse(output))],
                  );
                  await transaction.client.query(
                    `INSERT INTO ${relation(transaction, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,'completed') ON CONFLICT DO NOTHING`,
                    [ids.callId],
                  );
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_runs')} SET status='running' WHERE id=$1`,
                    [ids.runId],
                  );
                  return 'completed';
                }
                if (row.call.tool === 'images.generate') {
                  if (!options.images || !(await imageGenerationOffered(ids.workspaceId, definition.tools)))
                    throw new AccessDenied();
                  if (row.status === 'completed' || row.status === 'failed' || row.status === 'blocked')
                    return row.status;
                  if (
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status NOT IN ('completed','failed','blocked')`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  const owner = z.object({ user_id: z.string(), membership_id: z.uuid() }).parse(
                    (
                      await transaction.client.query(
                        `SELECT m.user_id,m.id AS membership_id FROM ${relation(transaction, 'tf_agent_runs')} r
            LEFT JOIN ${relation(transaction, 'tf_agent_schedules')} s ON s.id=r.schedule_id JOIN ${relation(transaction, 'tf_memberships')} m ON m.id=COALESCE(r.membership_id,s.sponsor_membership_id,r.sponsor_membership_id) AND m.removed_at IS NULL WHERE r.id=$1`,
                        [ids.runId],
                      )
                    ).rows[0],
                  );
                  // A task's images count against its credit allowance, in its flow; other runs bill in their own.
                  const task = binding
                    ? z
                        .object({ flow_id: z.uuid(), limits: z.object({ credits: z.number().int().nonnegative() }) })
                        .parse(
                          (
                            await transaction.client.query(
                              `SELECT flow_id,limits FROM ${relation(transaction, 'tf_agent_tasks')} WHERE id=$1`,
                              [binding.task_id],
                            )
                          ).rows[0],
                        )
                    : null;
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`,
                    [ids.callId],
                  );
                  return {
                    call: row.call,
                    actor: { kind: 'human' as const, userId: owner.user_id, membershipId: owner.membership_id },
                    images: {
                      agentId: run.agent_id,
                      flowId: task?.flow_id ?? ids.runId,
                      allowanceCredits: task ? String(task.limits.credits) : undefined,
                    },
                  };
                }
                if (row.call.tool === 'skills.execute' || row.call.tool === 'skills.files.read') {
                  const call = row.call;
                  if (
                    !options.skills ||
                    !procedures.some(skill => skill.id === call.skillId && skill.revision === call.revision)
                  )
                    throw new AccessDenied();
                  if (row.status === 'completed' || row.status === 'failed' || row.status === 'blocked')
                    return row.status;
                  if (
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status NOT IN ('completed','failed','blocked')`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  const owner = z.object({ user_id: z.string(), membership_id: z.uuid() }).parse(
                    (
                      await transaction.client.query(
                        `SELECT m.user_id,m.id AS membership_id FROM ${relation(transaction, 'tf_agent_runs')} r
            LEFT JOIN ${relation(transaction, 'tf_agent_schedules')} s ON s.id=r.schedule_id JOIN ${relation(transaction, 'tf_memberships')} m ON m.id=COALESCE(r.membership_id,s.sponsor_membership_id) AND m.removed_at IS NULL WHERE r.id=$1`,
                        [ids.runId],
                      )
                    ).rows[0],
                  );
                  if (call.tool === 'skills.execute' && run.kind === 'scheduled' && !call.folderId)
                    throw new AccessDenied();
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`,
                    [ids.callId],
                  );
                  return {
                    call,
                    actor: { kind: 'human' as const, userId: owner.user_id, membershipId: owner.membership_id },
                  };
                }
                if (isGitHubTaskCall(row.call)) {
                  const binding = await taskRun(transaction, ids.runId);
                  if (!options.github || !binding || run.kind !== 'delegated' || !run.user_id || !run.membership_id)
                    throw new AccessDenied();
                  if (row.status === 'completed' || row.status === 'failed' || row.status === 'blocked')
                    return row.status;
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`,
                    [ids.callId],
                  );
                  return {
                    call: row.call,
                    actor: { kind: 'human' as const, userId: run.user_id, membershipId: run.membership_id },
                    taskId: binding.task_id,
                    generation: binding.generation,
                  };
                }
                if (
                  row.call.tool === 'mcp.call' ||
                  row.call.tool === 'mcp.search' ||
                  row.call.tool === 'mcp.describe'
                ) {
                  const binding = await taskRun(transaction, ids.runId);
                  if (!options.mcp || !binding || run.kind !== 'delegated' || !run.user_id || !run.membership_id)
                    throw new AccessDenied();
                  if (row.status === 'completed' || row.status === 'failed' || row.status === 'blocked')
                    return row.status;
                  if (
                    !batch &&
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status NOT IN ('completed','failed','blocked')`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`,
                    [ids.callId],
                  );
                  return {
                    call: row.call,
                    actor: { kind: 'human' as const, userId: run.user_id, membershipId: run.membership_id },
                    taskId: binding.task_id,
                  };
                }
                if (
                  row.call.tool === 'knowledge.search' ||
                  row.call.tool === 'knowledge.read' ||
                  row.call.tool === 'knowledge.retrieve'
                ) {
                  const binding = await taskRun(transaction, ids.runId);
                  if (!binding || run.kind !== 'delegated' || !run.user_id || !run.membership_id)
                    throw new AccessDenied();
                  if (row.status === 'completed' || row.status === 'blocked' || row.status === 'failed')
                    return row.status;
                  if (
                    !batch &&
                    !taskAssociated &&
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status<>'completed'`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  const task = z
                    .object({ flow_id: z.uuid(), limits: z.object({ credits: z.number().int().nonnegative() }) })
                    .parse(
                      (
                        await transaction.client.query(
                          `SELECT flow_id,limits FROM ${relation(transaction, 'tf_agent_tasks')} WHERE id=$1`,
                          [binding.task_id],
                        )
                      ).rows[0],
                    );
                  const charged = z
                    .object({ spent: z.string() })
                    .parse(
                      (
                        await transaction.client.query(
                          `SELECT COALESCE(sum(COALESCE(charged,reserved)),0)::text AS spent FROM ${relation(transaction, 'tf_credit_usage')} WHERE flow_id=$1`,
                          [task.flow_id],
                        )
                      ).rows[0],
                    );
                  const exhausted =
                    knowledgeCallUsesQuery(row.call) &&
                    BigInt(charged.spent) + (await knowledgeTaskSpend(transaction, task.flow_id)) >=
                      BigInt(task.limits.credits) * 1000000000000n;
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`,
                    [ids.callId],
                  );
                  return {
                    call: row.call,
                    actor: { kind: 'human' as const, userId: run.user_id, membershipId: run.membership_id },
                    knowledge: { taskId: binding.task_id, flowId: task.flow_id, exhausted },
                  };
                }
                if (
                  row.call.tool === 'slack.message.send' ||
                  row.call.tool === 'slack.thread.reply' ||
                  row.call.tool === 'slack.reaction.add'
                ) {
                  if (!options.slack || !run.user_id || !run.membership_id) throw new AccessDenied();
                  if (
                    !(
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_slack_actions')} WHERE id=$1`,
                        [ids.callId],
                      )
                    ).rowCount &&
                    !(await canAccessAsset(transaction, actor, row.call.destinationId, row.call.tool))
                  )
                    throw new AccessDenied();
                  if (row.status === 'completed' || row.status === 'blocked' || row.status === 'failed')
                    return row.status;
                  if (
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status<>'completed'`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`,
                    [ids.callId],
                  );
                  return {
                    call: row.call,
                    actor: { kind: 'human' as const, userId: run.user_id, membershipId: run.membership_id },
                  };
                }
                if (
                  row.call.tool === 'google.read' ||
                  row.call.tool === 'google.propose' ||
                  row.call.tool === 'google.status' ||
                  row.call.tool === 'google.execute'
                ) {
                  const owner = await requireGoogleAgentOwner(transaction, ids.runId);
                  await captureExternalSources(transaction, ids, owner, row.call);
                  if (row.status === 'completed' || row.status === 'blocked' || row.status === 'failed')
                    return row.status;
                  if (
                    !batch &&
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id=$1 AND sequence<$2 AND status<>'completed'`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status='waiting' WHERE id=$1`,
                    [ids.callId],
                  );
                  return { call: row.call, actor: owner };
                }
                if (
                  row.call.tool === 'tables.list' ||
                  row.call.tool === 'skills.list' ||
                  row.call.tool === 'skills.read' ||
                  row.call.tool === 'web.fetch' ||
                  row.call.tool === 'web.search'
                ) {
                  if (row.status === 'completed' || row.status === 'blocked' || row.status === 'failed')
                    return row.status;
                  if (
                    !batch &&
                    !taskAssociated &&
                    (
                      await transaction.client.query(
                        `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id = $1 AND sequence < $2 AND status <> 'completed'`,
                        [ids.runId, row.sequence],
                      )
                    ).rowCount
                  )
                    return 'waiting';
                  const local: Runtime = { transaction: async (_workspace, _range, action) => action(transaction) };
                  let result;
                  switch (row.call.tool) {
                    case 'tables.list':
                      result = await createAgentRecordTools(local).list(ids.workspaceId, actor, row.call);
                      break;
                    case 'skills.list':
                      result = listSkills();
                      break;
                    case 'skills.read':
                      if (z.uuid().safeParse(row.call.skillId).success) {
                        if (row.call.resource) throw new AccessDenied();
                        const { sources: _sources, ...procedure } = await resolveRunProcedure(
                          transaction,
                          ids.runId,
                          row.call.skillId,
                          row.call.revision ?? '',
                        );
                        result = procedure;
                      } else result = readSkill(row.call.skillId, row.call.revision, row.call.resource);
                      break;
                    case 'web.fetch':
                      try {
                        result = await fetchPublicText(row.call.url);
                      } catch {
                        throw new TableError('web-fetch-failed', 400);
                      }
                      break;
                    case 'web.search':
                      result = await searchPublicWeb(row.call);
                      break;
                  }
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status = 'completed', result = $2 WHERE id = $1`,
                    [ids.callId, JSON.stringify(toolResultSchema.parse(result))],
                  );
                  return 'completed';
                }
                if (row.call.tool === 'github.issue.read') {
                  await requireIssueAccess(transaction, actor, row.call);
                  if (run.user_id && run.membership_id)
                    await captureExternalSources(
                      transaction,
                      ids,
                      { kind: 'human', userId: run.user_id, membershipId: run.membership_id },
                      row.call,
                    );
                  if (row.status === 'completed' || row.status === 'blocked' || row.status === 'failed')
                    return row.status;
                  const predecessor = await transaction.client.query(
                    `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id = $1 AND sequence < $2 AND status <> 'completed' LIMIT 1`,
                    [ids.runId, row.sequence],
                  );
                  if (!batch && predecessor.rowCount) return 'waiting';
                  await transaction.client.query(
                    `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status = 'waiting' WHERE id = $1`,
                    [ids.callId],
                  );
                  return { call: row.call, actor };
                }
                const permission =
                  row.call.tool === 'rows.create'
                    ? 'table.row.create'
                    : row.call.tool === 'rows.update'
                      ? 'table.row.update'
                      : row.call.tool === 'rows.delete'
                        ? 'table.row.delete'
                        : 'table.row.read';
                if (row.call.tool !== 'schema.inspect' && row.call.tool !== 'schema.status') {
                  await requireTablePermission(transaction, actor, row.call.tableId, permission);
                } else if (!(await canAccessTable(transaction, actor, row.call.tableId, 'table.schema.manage'))) {
                  await requireTablePermission(transaction, actor, row.call.tableId, 'table.row.read');
                }
                const boundResourceRuntime: Options['runtime'] = {
                  ...runtime,
                  transaction: async (workspaceId, compatibility, operation) => {
                    if (
                      workspaceId !== ids.workspaceId ||
                      transaction.commonVersion < compatibility.minimum ||
                      transaction.commonVersion > compatibility.maximum
                    )
                      throw new Error('Incompatible resource transaction');
                    return operation(transaction);
                  },
                };
                const resources = { records: createAgentRecordTools(boundResourceRuntime) };
                const registry = createToolRegistry(resources);
                if (row.status === 'completed') {
                  if (row.call.tool === 'schema.inspect' || row.call.tool === 'schema.status')
                    await resources.records.status(ids.workspaceId, actor, row.call.tableId);
                  return 'completed';
                }
                if (row.status === 'failed' || row.status === 'blocked') return row.status;
                const predecessor = await transaction.client.query(
                  `SELECT 1 FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE run_id = $1 AND sequence < $2 AND status <> 'completed' LIMIT 1`,
                  [ids.runId, row.sequence],
                );
                if (!batch && !taskAssociated && predecessor.rowCount) return 'waiting';
                const result = await registry.invoke(
                  { workspaceId: ids.workspaceId, actor, callId: ids.callId },
                  row.call,
                );
                await transaction.client.query(
                  `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status = 'completed', result = $2 WHERE id = $1`,
                  [ids.callId, JSON.stringify(toolResultSchema.parse(result ?? null))],
                );
                if (taskAssociated)
                  await transaction.client.query(
                    `INSERT INTO ${relation(transaction, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,'completed') ON CONFLICT DO NOTHING`,
                    [ids.callId],
                  );
                await transaction.client.query(
                  `UPDATE ${relation(transaction, 'tf_agent_runs')} SET status = 'running' WHERE id = $1`,
                  [ids.runId],
                );
                return 'completed';
              };
              const binding = await taskRun(transaction, ids.runId);
              const persisted = callRowSchema
                .optional()
                .parse(
                  (
                    await transaction.client.query(
                      `SELECT * FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE id=$1 AND run_id=$2`,
                      [ids.callId, ids.runId],
                    )
                  ).rows[0],
                );
              if (binding && persisted)
                await requireInvestigationToolBoundary(
                  transaction,
                  { taskId: binding.task_id, generation: binding.generation },
                  persisted.call.tool,
                );
              if (
                binding &&
                persisted &&
                !isGitHubTaskCall(persisted.call) &&
                ![
                  'tables.list',
                  'rows.list',
                  'rows.summarize',
                  'rows.resolveReference',
                  'rows.reverse',
                  'rows.get',
                  'schema.inspect',
                  'schema.status',
                  'skills.list',
                  'skills.read',
                ].includes(persisted.call.tool) &&
                (await protectedSourceClosure(transaction, [{ kind: 'private-task', taskId: binding.task_id }])).some(
                  source => source.kind === 'github-personal',
                )
              )
                throw new AccessDenied();
              const owner = binding
                ? await taskOutputAllowed(transaction, ids.workspaceId, ids.runId, persisted?.status !== 'completed')
                : null;
              const sources =
                owner && binding ? await taskMcpSources(transaction, owner, binding.task_id, ids.runId) : [];
              if (owner) await authorizeMcpSources({ transaction, actor: owner, sources });
              if (
                persisted &&
                !isMcpCall(persisted.call) &&
                sources.some(source => String(source.kind) === 'mcp-integration') &&
                (persisted.call.tool.startsWith('web.') ||
                  ((persisted.call.tool === 'knowledge.search' || persisted.call.tool === 'knowledge.retrieve') &&
                    knowledgeCallUsesQuery(persisted.call)) ||
                  persisted.call.tool.startsWith('slack.') ||
                  persisted.call.tool.startsWith('google.') ||
                  persisted.call.tool.startsWith('github.'))
              )
                throw new AccessDenied();
              const result =
                persisted && isMcpCall(persisted.call)
                  ? await executeCall()
                  : await withMcpSourceContext(transaction, sources, executeCall);
              if (typeof result === 'string') await work.settle(transaction);
              return result;
            },
            true,
            Boolean(batch),
          );
          if (typeof outcome === 'string') return z.enum(['completed', 'waiting', 'blocked', 'failed']).parse(outcome);
          if (isGitHubTaskCall(outcome.call)) {
            if (
              !options.github ||
              !('taskId' in outcome) ||
              !('generation' in outcome) ||
              outcome.actor.kind !== 'human'
            )
              throw new AccessDenied();
            const guarded: Runtime = {
              transaction: (workspaceId, range, action) =>
                runtime.transaction(workspaceId, range, async tx => {
                  if (workspaceId !== ids.workspaceId) throw new AccessDenied();
                  await lockAuthorization(tx);
                  const binding = await taskRun(tx, ids.runId);
                  if (!binding) throw new AccessDenied();
                  await lockTask(tx, binding.task_id);
                  await taskOutputAllowed(tx, workspaceId, ids.runId, true);
                  await resolveRunProcedures(tx, ids.runId);
                  if (!(await work.live(tx))) throw new AccessDenied();
                  return action(tx);
                }),
            };
            const response = await options.github(guarded).execute({
              workspaceId: ids.workspaceId,
              actor: outcome.actor,
              taskId: outcome.taskId,
              generation: outcome.generation,
              callId: ids.callId,
              call: outcome.call,
            });
            const status =
              response.state === 'waiting-approval' ||
              response.state === 'unresolved' ||
              response.state === 'tool-limit'
                ? 'waiting'
                : 'completed';
            const handoff =
              response.state === 'selection-required' || response.state === 'tool-limit'
                ? githubTaskHandoffs[response.state]
                : null;
            await executionTransaction(ids, async tx => {
              const owner = await taskOutputAllowed(tx, ids.workspaceId, ids.runId, true);
              await requireDraftSources(tx, owner, response.sources, new Set(), ids.runId);
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status=$2,result=$3 WHERE id=$1 AND status='waiting'`,
                [ids.callId, status, JSON.stringify(response)],
              );
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status=$2 WHERE id=$1`, [
                ids.runId,
                status === 'waiting' ? 'waiting' : 'running',
              ]);
              if (handoff) {
                await tx.client.query(
                  `UPDATE ${relation(tx, 'tf_agent_tasks')} SET status=$2,pause_reason=$3 WHERE id=$1`,
                  [outcome.taskId, handoff.status, response.state === 'tool-limit' ? 'limit.toolCalls' : null],
                );
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) SELECT $1,COALESCE(max(sequence)+1,0),$2,'agent',$3,'[]'::jsonb FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1`,
                  [outcome.taskId, outcome.generation, handoff.text],
                );
              }
            });
            return status;
          }
          if (
            outcome.call.tool === 'mcp.call' ||
            outcome.call.tool === 'mcp.search' ||
            outcome.call.tool === 'mcp.describe'
          ) {
            if (!options.mcp || !('taskId' in outcome) || outcome.actor.kind !== 'human') throw new AccessDenied();
            const guarded: Runtime = {
              transaction: (workspaceId, range, action) =>
                runtime.transaction(workspaceId, range, async tx => {
                  if (workspaceId !== ids.workspaceId) throw new AccessDenied();
                  await lockAuthorization(tx, 'write');
                  const binding = await taskRun(tx, ids.runId);
                  if (!binding) throw new AccessDenied();
                  await lockTask(tx, binding.task_id);
                  await taskOutputAllowed(tx, workspaceId, ids.runId, true);
                  await resolveRunProcedures(tx, ids.runId);
                  if (!(await work.live(tx))) throw new AccessDenied();
                  return action(tx);
                }),
            };
            const response = await options.mcp(guarded).execute(
              {
                workspaceId: ids.workspaceId,
                actor: outcome.actor,
                origin: { kind: 'named-task', taskId: outcome.taskId, stepId: ids.callId },
              },
              ids.callId,
              outcome.call,
            );
            const status = response.result.kind === 'waiting' ? 'waiting' : 'completed';
            await executionTransaction(ids, async tx => {
              await taskOutputAllowed(tx, ids.workspaceId, ids.runId, true);
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status=$2,result=$3 WHERE id=$1 AND status='waiting'`,
                [ids.callId, status, JSON.stringify(toolResultSchema.parse(response.result))],
              );
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status=$2 WHERE id=$1`, [
                ids.runId,
                status === 'waiting' ? 'waiting' : 'running',
              ]);
              if (status === 'completed')
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,'completed') ON CONFLICT DO NOTHING`,
                  [ids.callId],
                );
            });
            return status;
          }
          if (outcome.call.tool === 'images.generate') {
            const call = outcome.call,
              actor = outcome.actor;
            const billing = 'images' in outcome ? outcome.images : undefined;
            if (!options.images || actor.kind !== 'human' || !billing) throw new AccessDenied();
            const images = options.images;
            // Every generation write re-checks that the run and this call are still live.
            const transaction = <T>(operation: (tx: Transaction) => Promise<T>) =>
              runtime.transaction(ids.workspaceId, agentCompatibility, async tx => {
                await lockAuthorization(tx);
                await requireExternalRun(tx, ids.workspaceId, ids.runId, options.externalGuard);
                if (!(await work.live(tx))) throw new AccessDenied();
                return operation(tx);
              });
            const chosen = await transaction(async tx => images.choose(tx, ids.runId));
            const result = await generateImageOutputs(
              { files: images.files, transaction },
              {
                workspaceId: ids.workspaceId,
                actor,
                // No person asked for this in a private chat, so images go only to a folder the call names.
                autonomous: true,
                origin: { kind: 'run', runId: ids.runId },
                model: chosen.model,
                generate: chosen.generate,
                credits: {
                  flowId: billing.flowId,
                  activity: 'agent',
                  agentId: billing.agentId,
                  allowanceCredits: billing.allowanceCredits,
                },
              },
              call,
            );
            return transaction(async tx => {
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status='completed',result=$2 WHERE id=$1 AND status='waiting'`,
                [ids.callId, JSON.stringify(toolResultSchema.parse(result))],
              );
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status='running' WHERE id=$1`, [
                ids.runId,
              ]);
              if (work.reserved)
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,'completed') ON CONFLICT DO NOTHING`,
                  [ids.callId],
                );
              return 'completed' as const;
            });
          }
          if (outcome.call.tool === 'skills.execute' || outcome.call.tool === 'skills.files.read') {
            const call = outcome.call,
              actor = outcome.actor;
            if (!options.skills || actor.kind !== 'human') throw new AccessDenied();
            const guarded: Runtime = {
              transaction: (workspaceId, range, operation) =>
                runtime.transaction(workspaceId, range, async tx => {
                  if (workspaceId !== ids.workspaceId) throw new AccessDenied();
                  await lockAuthorization(tx);
                  await requireExternalRun(tx, workspaceId, ids.runId, options.externalGuard);
                  const pinned = await resolveRunProcedures(tx, ids.runId);
                  if (!pinned.some(skill => skill.id === call.skillId && skill.revision === call.revision))
                    throw new AccessDenied();
                  const binding = await taskRun(tx, ids.runId);
                  if (binding) await taskOutputAllowed(tx, workspaceId, ids.runId, true);
                  if (!(await work.live(tx))) throw new AccessDenied();
                  const persisted = await tx.client.query(
                    `SELECT 1 FROM ${relation(tx, 'tf_agent_tool_calls')} c JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=c.run_id
            JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision
            WHERE c.id=$1 AND c.run_id=$2 AND c.call=$3::jsonb AND c.status='waiting' AND d.definition->'tools' ? $4`,
                    [ids.callId, ids.runId, JSON.stringify(call), call.tool],
                  );
                  if (!persisted.rowCount) throw new AccessDenied();
                  return operation(tx);
                }),
            };
            const sources = await guarded.transaction(ids.workspaceId, agentCompatibility, async tx => {
              const binding = await taskRun(tx, ids.runId);
              if (binding) return [{ kind: 'private-task' as const, taskId: binding.task_id }];
              const rows = (
                await tx.client.query(
                  `SELECT c.call,c.result,s.sources FROM ${relation(tx, 'tf_agent_tool_calls')} c LEFT JOIN ${relation(tx, 'tf_slack_tool_sources')} s ON s.call_id=c.id WHERE c.run_id=$1 AND c.status='completed' ORDER BY c.sequence`,
                  [ids.runId],
                )
              ).rows;
              const sources: SourceDependency[] = [];
              for (const row of rows) {
                const previous = toolCallSchema.parse(row.call);
                sources.push(
                  ...sourceDependenciesSchema.parse(row.sources ?? []),
                  ...(await resultSources(tx, previous, row.result)),
                );
              }
              return sourceDependenciesSchema.parse(sources);
            });
            const context = {
              workspaceId: ids.workspaceId,
              actor,
              callId: ids.callId,
              scope: { kind: 'run' as const, id: ids.runId },
              sources,
            };
            const service = options.skills(guarded);
            const result =
              call.tool === 'skills.execute'
                ? await service.execute(context, call)
                : await service.readFile(context, call);
            return guarded.transaction(ids.workspaceId, agentCompatibility, async tx => {
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status='completed',result=$2 WHERE id=$1`,
                [ids.callId, JSON.stringify(toolResultSchema.parse(result))],
              );
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status='running' WHERE id=$1`, [
                ids.runId,
              ]);
              if (work.reserved)
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,'completed') ON CONFLICT DO NOTHING`,
                  [ids.callId],
                );
              return 'completed' as const;
            });
          }
          if (
            outcome.call.tool === 'knowledge.search' ||
            outcome.call.tool === 'knowledge.read' ||
            outcome.call.tool === 'knowledge.retrieve'
          ) {
            const call = outcome.call,
              owner = outcome.actor;
            const knowledge = 'knowledge' in outcome ? outcome.knowledge : undefined;
            if (owner.kind !== 'human' || !knowledge) throw new AccessDenied();
            const guarded: Runtime = {
              transaction: (workspaceId, range, action) =>
                runtime.transaction(workspaceId, range, async tx => {
                  if (workspaceId !== ids.workspaceId) throw new AccessDenied();
                  await lockAuthorization(tx);
                  const binding = await taskRun(tx, ids.runId);
                  if (!binding || binding.task_id !== knowledge.taskId) throw new AccessDenied();
                  await taskOutputAllowed(tx, workspaceId, ids.runId, true);
                  if (!(await work.live(tx))) throw new AccessDenied();
                  return action(tx);
                }),
            };
            let output: {
              result: Record<string, unknown>;
              sources: z.infer<typeof knowledgeToolResultSchema>['sources'];
            };
            if (!options.knowledge) output = { result: knowledgeToolsUnavailable, sources: [] };
            else if (knowledge.exhausted)
              output = {
                result: {
                  ...knowledgeToolsUnavailable,
                  instruction:
                    'The task credit limit is reached, so knowledge search did not run. Report the limit; do not invent knowledge evidence.',
                },
                sources: [],
              };
            else
              try {
                output = await invokeBoundedKnowledge(
                  guarded,
                  options.knowledge,
                  ids.workspaceId,
                  owner,
                  call,
                  {
                    commandId: ids.callId,
                    runId: ids.runId,
                    taskFlowId: knowledge.flowId,
                    deadlineAt: Math.min(Date.now() + 90_000, work.deadlineAt ?? Infinity),
                  },
                  runtime,
                );
              } catch (error) {
                if (error instanceof AccessDenied) throw error;
                output = { result: knowledgeToolsUnavailable, sources: [] };
              }
            const result = knowledgeToolResultSchema.parse({ ...output.result, sources: output.sources });
            await executionTransaction(ids, async tx => {
              const current = await taskOutputAllowed(tx, ids.workspaceId, ids.runId, true);
              await requireDraftSources(tx, current, result.sources, new Set(), ids.runId);
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status='completed',result=$2 WHERE id=$1 AND status='waiting'`,
                [ids.callId, JSON.stringify(result)],
              );
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status='running' WHERE id=$1`, [
                ids.runId,
              ]);
              await tx.client.query(
                `INSERT INTO ${relation(tx, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,'completed') ON CONFLICT DO NOTHING`,
                [ids.callId],
              );
            });
            return 'completed';
          }
          if (
            outcome.call.tool === 'slack.message.send' ||
            outcome.call.tool === 'slack.thread.reply' ||
            outcome.call.tool === 'slack.reaction.add'
          ) {
            if (!options.slack) throw new AccessDenied();
            const guarded: Runtime = {
              transaction: (workspaceId, range, action) =>
                runtime.transaction(workspaceId, range, async tx => {
                  if (workspaceId !== ids.workspaceId) throw new AccessDenied();
                  await lockAuthorization(tx);
                  const binding = await taskRun(tx, ids.runId);
                  if (binding) await lockTask(tx, binding.task_id);
                  await requireExternalRun(tx, workspaceId, ids.runId, options.externalGuard);
                  await resolveRunProcedures(tx, ids.runId);
                  if (await taskRun(tx, ids.runId)) await taskOutputAllowed(tx, workspaceId, ids.runId, true);
                  return action(tx);
                }),
            };
            const service = options.slack(guarded);
            const result = await service.execute(
              ids.workspaceId,
              ids.runId,
              ids.callId,
              outcome.call,
              work.reserved
                ? async tx => {
                    if (!(await work.live(tx))) throw new AccessDenied();
                  }
                : undefined,
            );
            const status =
              result.status === 'sent'
                ? 'completed'
                : ['pending', 'approved', 'retry', 'sending'].includes(result.status)
                  ? 'waiting'
                  : 'failed';
            await executionTransaction(ids, async tx => {
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status=$2,result=$3 WHERE id=$1 AND status='waiting'`,
                [ids.callId, status, JSON.stringify(result)],
              );
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status=$2 WHERE id=$1`, [
                ids.runId,
                status === 'waiting' ? 'waiting' : 'running',
              ]);
              if (work.reserved && status !== 'waiting')
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_agent_task_action_receipts')} (call_id,status) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                  [ids.callId, status === 'completed' ? 'completed' : 'failed'],
                );
            });
            try {
              await service.notify(ids.workspaceId, ids.callId);
            } catch {}
            return status;
          }
          if (outcome.call.tool !== 'github.issue.read') {
            const owner = outcome.actor;
            if (owner.kind !== 'human') throw new AccessDenied();
            const guarded: Runtime = {
              transaction: (workspaceId, range, action) =>
                runtime.transaction(workspaceId, range, async tx => {
                  if (workspaceId !== ids.workspaceId) throw new AccessDenied();
                  await lockAuthorization(tx);
                  await requireExternalRun(tx, workspaceId, ids.runId, options.externalGuard);
                  const current = await requireGoogleAgentOwner(tx, ids.runId);
                  if (current.userId !== owner.userId || current.membershipId !== owner.membershipId)
                    throw new AccessDenied();
                  await resolveRunProcedures(tx, ids.runId);
                  const persisted = await tx.client.query(
                    `SELECT 1 FROM ${relation(tx, 'tf_agent_tool_calls')} c JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=c.run_id JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision WHERE c.id=$1 AND c.run_id=$2 AND c.call=$3::jsonb AND c.status IN ('waiting','completed') AND d.definition->'tools' ? $4 AND ($5::boolean OR NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_tool_calls')} p WHERE p.run_id=c.run_id AND p.sequence<c.sequence AND p.status<>'completed'))`,
                    [ids.callId, ids.runId, JSON.stringify(outcome.call), outcome.call.tool, Boolean(batch)],
                  );
                  if (!persisted.rowCount) throw new AccessDenied();
                  await options.internalActivity?.(tx, ids);
                  return action(tx);
                }),
            };
            const result = await invokeGoogleTool(
              guarded,
              options.google,
              { workspaceId: ids.workspaceId, actor: owner, callId: ids.callId },
              outcome.call,
            );
            return await guarded.transaction(ids.workspaceId, agentCompatibility, async tx => {
              const status = 'error' in result ? 'failed' : 'completed';
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status=$3, result=$2 WHERE id=$1 AND status='waiting'`,
                [ids.callId, JSON.stringify(result), status],
              );
              await tx.client.query(`UPDATE ${relation(tx, 'tf_agent_runs')} SET status='running' WHERE id=$1`, [
                ids.runId,
              ]);
              await options.internalActivity?.(tx, ids);
              return status;
            });
          }
          const issueCall = outcome.call;
          if (!options.integrations) throw new IntegrationError('provider-failed');
          const guarded: Runtime = {
            transaction: (workspaceId, range, action) =>
              runtime.transaction(workspaceId, range, async tx => {
                if (workspaceId !== ids.workspaceId) throw new AccessDenied();
                await lockAuthorization(tx);
                await requireExternalRun(tx, workspaceId, ids.runId, options.externalGuard);
                return action(tx);
              }),
          };
          const integrations = options.externalGuard
            ? createIntegrationService({ runtime: guarded, keyring: integrationCredentialKeyring() })
            : options.integrations;
          let result;
          try {
            result = await integrations.readIssue(ids.workspaceId, outcome.actor, {
              requestId: ids.callId,
              integrationId: outcome.call.integrationId,
              sourceId: outcome.call.sourceId,
              issueNumber: outcome.call.issueNumber,
            });
          } catch (error) {
            if (
              error instanceof IntegrationError &&
              (error.code === 'in-progress' || error.code === 'provider-retryable')
            )
              return 'waiting';
            throw error;
          }
          return await executionTransaction(ids, async transaction => {
            await lockAuthorization(transaction);
            const run = runRowSchema
              .optional()
              .parse(
                (
                  await transaction.client.query(
                    `SELECT * FROM ${relation(transaction, 'tf_agent_runs')} WHERE id = $1 FOR UPDATE`,
                    [ids.runId],
                  )
                ).rows[0],
              );
            if (!run || !['ready', 'running', 'waiting'].includes(run.status)) throw new AccessDenied();
            await requireIssueAccess(transaction, outcome.actor, issueCall);
            await requireExternalRun(transaction, ids.workspaceId, ids.runId, options.externalGuard);
            await resolveRunProcedures(transaction, ids.runId);
            const row = callRowSchema.parse(
              (
                await transaction.client.query(
                  `SELECT * FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE id = $1 AND run_id = $2 FOR UPDATE`,
                  [ids.callId, ids.runId],
                )
              ).rows[0],
            );
            if (row.status === 'completed' || row.status === 'blocked' || row.status === 'failed') return row.status;
            await transaction.client.query(
              `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status = 'completed', result = $2 WHERE id = $1`,
              [ids.callId, JSON.stringify(toolResultSchema.parse(result))],
            );
            await transaction.client.query(
              `UPDATE ${relation(transaction, 'tf_agent_runs')} SET status = 'running' WHERE id = $1`,
              [ids.runId],
            );
            return 'completed';
          });
        } catch (error) {
          if (error instanceof TaskApprovalError && error.code === 'approval-required') return 'waiting';
          if (
            !(error instanceof TaskApprovalError) &&
            !(error instanceof AccessDenied) &&
            !(error instanceof GoogleLifecycleError) &&
            !(error instanceof GoogleOperationError) &&
            !(error instanceof GoogleWorkspaceError) &&
            !(error instanceof TableError) &&
            !(error instanceof IntegrationError) &&
            !(error instanceof z.ZodError) &&
            !(error instanceof TableValidationError) &&
            !(error instanceof GenerationError) &&
            !(error instanceof WorkspaceMemberError)
          )
            throw new Error('Agent tool execution unavailable');
          const status = error instanceof AccessDenied ? 'blocked' : 'failed';
          if (failed) failed(errorType(error));
          else
            log('error', 'tool', 'call_failed', {
              runtime: options.telemetryRuntime ?? 'agent',
              operation: 'agent.tool',
              outcome: status === 'blocked' ? 'blocked' : 'error',
              'error.type': errorType(error),
            });
          await executionTransaction(ids, async transaction => {
            await lockAuthorization(transaction);
            const task = await taskRun(transaction, ids.runId);
            const tool = (
              await transaction.client.query(
                `SELECT call->>'tool' AS tool FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE id = $1 AND run_id = $2`,
                [ids.callId, ids.runId],
              )
            ).rows[0]?.tool;
            const conflict =
              !task &&
              (tool === 'rows.update' || tool === 'rows.delete') &&
              error instanceof GenerationError &&
              error.code === 'stale-record'
                ? recordConflict
                : null;
            const memberError = error instanceof WorkspaceMemberError ? { code: error.code } : null;
            await transaction.client.query(
              `UPDATE ${relation(transaction, 'tf_agent_tool_calls')} SET status = $3, result = $4 WHERE id = $1 AND run_id = $2 AND status <> 'completed'`,
              [
                ids.callId,
                ids.runId,
                status,
                JSON.stringify(
                  conflict ??
                    memberError ??
                    googleToolError(error) ?? { code: status === 'blocked' ? 'access-denied' : 'tool-failed' },
                ),
              ],
            );
            if (task)
              await transaction.client.query(
                `INSERT INTO ${relation(transaction, 'tf_agent_task_action_receipts')} (call_id,status) SELECT id,'failed' FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE id=$1 AND run_id=$2 AND status<>'completed' ON CONFLICT DO NOTHING`,
                [ids.callId, ids.runId],
              );
          });
          return status;
        }
      },
    );
  }

  async function executeBatch(input: readonly ExecutionIds[]): Promise<ExecutionStatus[]> {
    const ids = z.array(executionIdsSchema).min(2).max(8).parse(input);
    const first = ids[0];
    if (!first) throw new AccessDenied();
    const { workspaceId, runId } = first;
    if (
      ids.some(item => item.workspaceId !== workspaceId || item.runId !== runId) ||
      new Set(ids.map(item => item.callId)).size !== ids.length
    )
      throw new AccessDenied();
    const admitted = await runtime.transaction(workspaceId, agentCompatibility, async tx => {
      await lockAuthorization(tx);
      await tx.client.query(`SELECT id FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1 FOR UPDATE`, [runId]);
      const rows = callRowSchema
        .array()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1 AND id=ANY($2::uuid[]) ORDER BY sequence`,
              [runId, ids.map(item => item.callId)],
            )
          ).rows,
        );
      if (rows.length !== ids.length || rows.some(row => !readOnlyTools.has(row.call.tool))) throw new AccessDenied();
      const binding = await taskRun(tx, runId);
      if (!binding) return { activity: null };
      await lockTask(tx, binding.task_id);
      if (await activeTaskWork(tx, binding.task_id)) return null;
      for (const row of rows) if (!(await admitTaskCall(tx, binding.task_id, row.id))) return null;
      const activity = await reserveTaskWork(tx, binding.task_id, 'tool');
      return activity ? { activity } : null;
    });
    if (!admitted) return ids.map(() => 'waiting');
    return withTaskWork(
      operation => executionTransaction(first, operation),
      async work => {
        const pending = ids.entries();
        const statuses: ExecutionStatus[] = [];
        let blocked = false;
        await work.admit(admitted.activity ?? 'legacy');
        const run = async () => {
          for (const [index, item] of pending) {
            if (blocked) return;
            const status = await execute(item, { work });
            statuses[index] = status;
            if (status === 'blocked') blocked = true;
          }
        };
        const settled = await Promise.allSettled([run(), run()]);
        for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
        if (blocked) {
          const unstarted = ids.filter((_item, index) => !statuses[index]);
          if (unstarted.length)
            await runtime.transaction(workspaceId, agentCompatibility, tx =>
              tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_tool_calls')} SET status='blocked',result='{"code":"access-denied"}'::jsonb WHERE run_id=$1 AND id=ANY($2::uuid[]) AND status='pending'`,
                [runId, unstarted.map(item => item.callId)],
              ),
            );
        }
        return ids.map((_item, index) => statuses[index] ?? 'blocked');
      },
    );
  }

  async function readResult(input: ExecutionIds, human: HumanActor) {
    const ids = executionIdsSchema.parse(input);
    return runtime.transaction(ids.workspaceId, agentCompatibility, async transaction => {
      await lockAuthorization(transaction);
      await currentMember(transaction, human);
      await requireHumanRun(transaction, ids.runId);
      await requireExternalRun(transaction, ids.workspaceId, ids.runId, options.externalGuard);
      const run = runRowSchema
        .optional()
        .parse(
          (
            await transaction.client.query(`SELECT * FROM ${relation(transaction, 'tf_agent_runs')} WHERE id = $1`, [
              ids.runId,
            ])
          ).rows[0],
        );
      if (!run) throw new AccessDenied();
      await requireAgentRunHistory(transaction, human, ids.runId);
      const row = callRowSchema
        .optional()
        .parse(
          (
            await transaction.client.query(
              `SELECT * FROM ${relation(transaction, 'tf_agent_tool_calls')} WHERE id = $1 AND run_id = $2`,
              [ids.callId, ids.runId],
            )
          ).rows[0],
        );
      if (!row) throw new AccessDenied();
      if (await taskRun(transaction, ids.runId))
        await taskOutputAllowed(transaction, ids.workspaceId, ids.runId, false);
      await resolveRunProcedures(transaction, ids.runId);
      if (isGitHubTaskCall(row.call)) {
        if (!(await taskRun(transaction, ids.runId))) throw new AccessDenied();
        const github = githubTaskResultSchema.safeParse(row.result);
        if (github.success) await requireDraftSources(transaction, human, github.data.sources);
        return { status: row.status, result: row.result };
      }
      if (row.call.tool === 'agents.task.start' || row.call.tool === 'agents.task.read') {
        const binding = await taskRun(transaction, ids.runId);
        if (!binding) throw new AccessDenied();
        const taskId =
          row.call.tool === 'agents.task.start'
            ? z.object({ taskId: z.uuid() }).parse(row.result).taskId
            : row.call.taskId;
        const result = await createAgentTasks(boundRuntime(transaction, ids.workspaceId)).readResult(
          ids.workspaceId,
          human.userId,
          taskId,
          binding.task_id,
        );
        return { status: row.status, result };
      }
      if (row.call.tool === 'mcp.call' || row.call.tool === 'mcp.search' || row.call.tool === 'mcp.describe') {
        if (!(await taskRun(transaction, ids.runId))) throw new AccessDenied();
        return { status: row.status, result: row.result };
      }
      if (
        row.call.tool === 'knowledge.search' ||
        row.call.tool === 'knowledge.read' ||
        row.call.tool === 'knowledge.retrieve'
      ) {
        if (!(await taskRun(transaction, ids.runId))) throw new AccessDenied();
        const parsed = knowledgeToolResultSchema.safeParse(row.result);
        if (!parsed.success) return { status: row.status, result: row.result };
        try {
          await requireDraftSources(transaction, human, parsed.data.sources);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          return {
            status: row.status,
            result: {
              ...knowledgeToolsUnavailable,
              instruction: 'This knowledge result is unavailable because a cited source changed or your access ended.',
              sources: [],
            },
          };
        }
        return { status: row.status, result: row.result };
      }
      if (
        row.call.tool === 'slack.message.send' ||
        row.call.tool === 'slack.thread.reply' ||
        row.call.tool === 'slack.reaction.add'
      ) {
        if (
          !(await canAccessAsset(
            transaction,
            { kind: 'agent', runId: ids.runId },
            row.call.destinationId,
            row.call.tool,
          ))
        )
          throw new AccessDenied();
        return { status: row.status, result: row.result };
      }
      if (
        row.call.tool === 'google.read' ||
        row.call.tool === 'google.propose' ||
        row.call.tool === 'google.status' ||
        row.call.tool === 'google.execute'
      ) {
        const owner = await requireGoogleAgentOwner(
          transaction,
          ids.runId,
          googleToolErrorSchema.safeParse(row.result).success ? 'optional' : 'required',
        );
        if (owner.userId !== human.userId || owner.membershipId !== human.membershipId) throw new AccessDenied();
        return { status: row.status, result: row.result };
      }
      if (row.call.tool === 'images.generate') return { status: row.status, result: row.result };
      if (row.call.tool === 'skills.execute' || row.call.tool === 'skills.files.read') {
        const output = skillExecutionResultSchema.safeParse(row.result);
        if (output.success) await requireDraftSources(transaction, human, output.data.sources);
        return { status: row.status, result: row.result };
      }
      if (
        row.call.tool === 'tables.list' ||
        row.call.tool === 'skills.list' ||
        row.call.tool === 'skills.read' ||
        row.call.tool === 'web.fetch' ||
        row.call.tool === 'web.search'
      ) {
        if (row.call.tool === 'tables.list') {
          const local: Runtime = { transaction: async (_workspace, _range, action) => action(transaction) };
          return {
            status: row.status,
            result: await createAgentRecordTools(local).list(
              ids.workspaceId,
              { kind: 'agent', runId: ids.runId },
              row.call,
            ),
          };
        }
        return { status: row.status, result: row.result };
      }
      if (row.call.tool === 'github.issue.read') {
        for (const principal of [human, { kind: 'agent', runId: ids.runId } satisfies Actor])
          await requireIssueAccess(transaction, principal, row.call);
        return { status: row.status, result: row.result };
      }
      const schemaReadable = row.call.tool === 'schema.inspect' || row.call.tool === 'schema.status';
      const permission = row.call.tool === 'rows.delete' ? 'table.row.delete' : 'table.row.read';
      const assetId = row.call.tableId;
      const linked = await queryTargetTables(transaction, row.call, row.result);
      for (const principal of [human, { kind: 'agent', runId: ids.runId } satisfies Actor]) {
        if (!schemaReadable || !(await canAccessTable(transaction, principal, assetId, 'table.schema.manage')))
          await requireTablePermission(transaction, principal, assetId, permission);
        for (const tableId of linked) await requireTablePermission(transaction, principal, tableId, 'table.row.read');
      }
      return { status: row.status, result: await markAgentRecordResult(transaction, human, row.result) };
    });
  }

  async function executeAgentTool(ids: ExecutionIds) {
    try {
      return await execute(ids);
    } catch {
      throw new Error('Agent tool execution unavailable');
    }
  }

  return { ...store, execute, executeBatch, readResult, activities: { executeAgentTool } };
}
