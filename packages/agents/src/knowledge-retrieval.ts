import { z } from 'zod';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  KnowledgeBudgetError,
  knowledgeRootSchema,
  readKnowledgeBudget,
  writeKnowledgeBudget,
  reserveKnowledgeOperation,
  knowledgeBudgetMetadata,
  type KnowledgeRoot,
} from '@tulipfarm/workspace-storage/knowledge-retrieval';
import type { AgentStorage, AgentTransaction } from './store.ts';
import {
  knowledgeRetrieveInputSchema,
  type KnowledgeToolCall,
  type KnowledgeTools,
  type KnowledgeCallContext,
} from './knowledge-tool-contracts.ts';
import { AccessDenied, type HumanActor } from '@tulipfarm/access';
import { requireDraftSources } from './draft-sources.ts';
import { knowledgeToolResultSchema } from './knowledge-tool-contracts.ts';
import { errorAttributes, log } from '@tulipfarm/observability';
const relation = (tx: AgentTransaction, name: string) => qualified(tx.schema, name);

export type KnowledgeRootOrigin =
  | {
      kind: 'chat-call';
      callId: string;
      tool: 'agents.task.start' | 'agents.delegate' | KnowledgeToolCall['tool'];
      turnId?: string;
    }
  | { kind: 'plan-attempt'; attemptId: string };

export async function knowledgeRootForRequest(
  tx: AgentTransaction,
  actor: HumanActor,
  origin: KnowledgeRootOrigin,
): Promise<KnowledgeRoot | null> {
  if (origin.kind === 'chat-call') {
    const chat = (
      await tx.client.query(
        `SELECT c.turn_id FROM ${relation(tx, 'tf_conversation_tool_calls')} c JOIN ${relation(tx, 'tf_conversations')} p ON p.id=c.conversation_id WHERE c.id=$1 AND c.tool=$2 AND ($3::uuid IS NULL OR c.turn_id=$3) AND p.owner_user_id=$4 AND p.owner_membership_id=$5`,
        [origin.callId, origin.tool, origin.turnId ?? null, actor.userId, actor.membershipId],
      )
    ).rows[0];
    if (!chat) throw new AccessDenied();
    return { kind: 'chat', id: z.uuid().parse(chat.turn_id) };
  }
  const plan = (
    await tx.client.query(
      `SELECT p.source_turn_id FROM ${relation(tx, 'tf_agent_plan_attempts')} a JOIN ${relation(tx, 'tf_agent_plans')} p ON p.id=a.plan_id WHERE a.id=$1 AND p.starter_user_id=$2 AND p.starter_membership_id=$3`,
      [origin.attemptId, actor.userId, actor.membershipId],
    )
  ).rows[0];
  if (!plan) throw new AccessDenied();
  return plan?.source_turn_id ? { kind: 'chat', id: z.uuid().parse(plan.source_turn_id) } : null;
}

export async function invokeBoundedKnowledge(
  runtime: AgentStorage,
  createTools: (runtime: AgentStorage) => KnowledgeTools,
  workspaceId: string,
  actor: HumanActor,
  call: KnowledgeToolCall,
  context: KnowledgeCallContext & { turnId?: string; attemptId?: string },
  settlementRuntime: AgentStorage = runtime,
) {
  context = { ...context, deadlineAt: context.deadlineAt ?? Date.now() + 90_000 };
  let root!: KnowledgeRoot;
  let priorCitationIds: string[] = [];
  let admissionBudget: ReturnType<typeof knowledgeBudgetMetadata> | undefined;
  const range = {
    ...commonCompatibility,
    minimum: 1,
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
  };
  try {
    root = await runtime.transaction(workspaceId, range, async tx => {
      if (context.turnId) return { kind: 'chat' as const, id: context.turnId };
      if (context.runId) {
        const row = (
          await tx.client.query(
            `SELECT knowledge_root FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1 AND id=$2`,
            [context.runId, context.commandId],
          )
        ).rows[0];
        if (row?.knowledge_root) return knowledgeRootSchema.parse(row.knowledge_root);
        throw new KnowledgeBudgetError('knowledge-recovery-required');
      }
      const found = await knowledgeRootForRequest(
        tx,
        actor,
        context.attemptId
          ? { kind: 'plan-attempt', attemptId: context.attemptId }
          : { kind: 'chat-call', callId: context.commandId, tool: call.tool },
      );
      if (!found) throw new KnowledgeBudgetError('knowledge-recovery-required');
      return found;
    });
    await runtime.transaction(workspaceId, range, async tx => {
      context.signal?.throwIfAborted();
      const state = await readKnowledgeBudget(tx, root);
      admissionBudget = knowledgeBudgetMetadata(state);
      priorCitationIds = state.completeCitationIds;
      const grouped = call.tool === 'knowledge.retrieve';
      const count = call.tool === 'knowledge.retrieve' && call.action === 'expand' ? call.branches!.length : 1;
      const initial = call.tool !== 'knowledge.retrieve' || call.action === 'search';
      await writeKnowledgeBudget(
        tx,
        root,
        reserveKnowledgeOperation(state, context.commandId, call, count, grouped, initial),
      );
    });
  } catch (error) {
    if (!(error instanceof KnowledgeBudgetError)) throw error;
    if (
      error.code === 'knowledge-budget-exhausted' &&
      admissionBudget &&
      !admissionBudget.stop &&
      call.tool === 'knowledge.retrieve' &&
      ((call.action === 'search' && admissionBudget.initialRemaining === 0) ||
        (call.action === 'expand' && admissionBudget.initialRemaining === 1))
    ) {
      return {
        result: {
          provider: 'knowledge',
          error: 'knowledge-action-required',
          budget: admissionBudget,
          instruction: admissionBudget.initialRemaining
            ? 'Not run; no allowance was consumed. First use action="search" with one short topic query, not a list of subjects.'
            : 'Not run; no additional allowance was consumed. The initial search is already spent, but expansion remains. Use action="expand" in ONE call with a branches array of one to three independent short queries or citation anchors for missing facts. Do not send another action="search". Existing branch limits still apply.',
        },
        sources: [],
      };
    }
    if (error.code === 'knowledge-operation-spent') {
      const replay = await runtime.transaction(workspaceId, range, async tx => {
        const state = await readKnowledgeBudget(tx, root);
        const operation = state.operations.find(operation => operation.id === context.commandId);
        if (!operation || operation.status !== 'completed' || !z.uuid().safeParse(operation.id).success) return null;
        const receipt = context.runId
          ? (
              await tx.client.query(
                `SELECT result FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=$1 AND status='completed'`,
                [operation.id],
              )
            ).rows[0]?.result
          : (
              await tx.client.query(
                `SELECT output FROM ${relation(tx, 'tf_conversation_execution_steps')} WHERE call_id=$1`,
                [operation.id],
              )
            ).rows[0]?.output;
        if (!receipt) return null;
        const parsed = knowledgeToolResultSchema.parse(
          context.runId ? receipt : { ...receipt.result, sources: receipt.sources },
        );
        await requireDraftSources(tx, actor, parsed.sources, new Set(), context.runId);
        const { sources, ...result } = parsed;
        return { result: { ...result, budget: knowledgeBudgetMetadata(state) }, sources };
      });
      if (replay) return replay;
    }
    return {
      result: {
        provider: 'knowledge',
        error: error.code,
        ...(admissionBudget ? { budget: admissionBudget } : {}),
        instruction:
          'Do not retry retrieval. Use authorized evidence already returned and state any missing facts. Recovery of an older request requires a new explicit human request.',
      },
      sources: [],
    };
  }
  let completed = false;
  const controller = new AbortController();
  // Guarded SQL shares root/plan locks; serialize those transactions while provider branch work still overlaps.
  let transactionQueue = Promise.resolve();
  const monitored: AgentStorage = {
    transaction: (workspace, compatibility, operation) => {
      const result = transactionQueue.then(() => runtime.transaction(workspace, compatibility, operation));
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  context = {
    ...context,
    excludeCitationIds: priorCitationIds,
    signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
  };
  const deadline = setTimeout(
    () => controller.abort(new Error('knowledge-deadline')),
    Math.max(0, context.deadlineAt! - Date.now()),
  );
  let checking = false;
  const fence = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void monitored
      .transaction(workspaceId, range, async () => undefined)
      .catch(error => controller.abort(error))
      .finally(() => {
        checking = false;
      });
  }, 500);
  try {
    context.signal?.throwIfAborted();
    const tools = createTools(monitored);
    let output;
    if (call.tool === 'knowledge.read') output = await tools.read(workspaceId, actor, call.citationId, context);
    else {
      const { tool: _tool, ...input } = call;
      output =
        call.tool === 'knowledge.retrieve'
          ? await tools.retrieve(workspaceId, actor, knowledgeRetrieveInputSchema.parse(input), context)
          : await tools.search(workspaceId, actor, input as Parameters<KnowledgeTools['search']>[2], context);
    }
    context.signal?.throwIfAborted();
    clearInterval(fence);
    const budget = await monitored.transaction(workspaceId, range, async tx => {
      const state = await readKnowledgeBudget(tx, root);
      const operation = state.operations.find(operation => operation.id === context.commandId);
      if (!operation) throw new KnowledgeBudgetError('knowledge-recovery-required');
      const budget = knowledgeBudgetMetadata(state);
      output.result = { ...output.result, budget };
      if (JSON.stringify(output).length > 64_000) {
        const bounded = z
          .object({
            branches: z.array(
              z
                .object({
                  documents: z.array(
                    z
                      .object({
                        completeness: z.enum(['complete', 'partial']),
                        omitted: z.boolean(),
                        passages: z.array(z.object({ text: z.string(), truncated: z.boolean() }).passthrough()),
                      })
                      .passthrough(),
                  ),
                })
                .passthrough(),
            ),
          })
          .passthrough()
          .parse(output.result);
        for (const branch of [...bounded.branches].reverse())
          for (const document of [...branch.documents].reverse()) {
            while (document.passages.length && JSON.stringify({ ...output, result: bounded }).length > 64_000) {
              document.passages.pop();
              document.omitted = true;
              document.completeness = 'partial';
            }
          }
        output.result = bounded;
        if (JSON.stringify(output).length > 64_000) throw new Error('knowledge-result-too-large');
      }
      operation.status = 'completed';
      const passages = z
        .object({
          branches: z.array(
            z.object({
              documents: z.array(
                z.object({ passages: z.array(z.object({ citationId: z.string(), truncated: z.boolean() })) }),
              ),
            }),
          ),
        })
        .safeParse(output.result);
      const complete = passages.success
        ? passages.data.branches.flatMap(branch =>
            branch.documents.flatMap(document =>
              document.passages.filter(passage => !passage.truncated).map(passage => passage.citationId),
            ),
          )
        : typeof output.result.citationId === 'string' && output.result.truncated === false
          ? [output.result.citationId]
          : [];
      state.completeCitationIds = [...new Set([...state.completeCitationIds, ...complete])];
      await writeKnowledgeBudget(tx, root, state);
      return budget;
    });
    completed = true;
    const result = { ...output.result, budget };
    if (JSON.stringify({ result, sources: output.sources }).length > 64_000)
      throw new Error('knowledge-result-too-large');
    return { ...output, result };
  } finally {
    clearTimeout(deadline);
    clearInterval(fence);
    controller.abort();
    await transactionQueue;
    if (!completed)
      await settlementRuntime
        .transaction(workspaceId, { ...commonCompatibility, minimum: 1 }, async tx => {
          const state = await readKnowledgeBudget(tx, root);
          const operation = state.operations.find(operation => operation.id === context.commandId);
          if (operation?.status === 'running') operation.status = 'failed';
          await writeKnowledgeBudget(tx, root, state);
        })
        .catch(error => {
          log('error', 'dependency', 'call_failed', {
            operation: 'knowledge.retrieval.settlement',
            ...errorAttributes(error),
          });
        });
  }
}

export { withKnowledgeRetrieveGrant } from './knowledge-tool-contracts.ts';
