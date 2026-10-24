import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { imageGenerationOffered } from './image-generation.ts';
import { storedToolPresentation, storedToolStatus } from '@tulipfarm/conversations/tool-activity-history';
import { settleCredits } from '@tulipfarm/workspace-storage/credits';
import { AccessDenied, canAccessAsset, currentMember, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { createAgentExecutor } from './executor.ts';
import {
  agentDefinitionSchema,
  recordConflict,
  scopeSchema,
  toolCallSchema,
  toolResultSchema,
  type ExecutionStatus,
} from './contracts.ts';
import { chatInputSchema, chatReceiptSchema, modelAttemptReceiptSchema } from './chat-contracts.ts';
import { modelDecisionSchema } from './model.ts';
import type { InferenceResult } from './inference.ts';
import { AgentError } from './saved-contracts.ts';
import { requireAgentPermission } from './saved-policy.ts';
import { requireHumanRun } from './internal-privacy.ts';
import { requireChatInvocation, requireExternalRun, type ExternalRunGuard } from './external-run.ts';
import { relation, type AgentTransaction } from './store.ts';
import { resolveRunProcedures } from './workspace-skills.ts';
import { requireGoogleAgentOwner, type GoogleOperationsFactory } from './google-tools.ts';
import type { SlackActionsFactory } from './slack-actions.ts';
import {
  admitGeneration,
  claimAttempt,
  failGeneration,
  latestGeneration,
  permitted,
  previousRetry,
  recordWinner,
  retryModelSchema,
  reportUsage,
  settleAttempt,
  type MeteredUsage,
  type ModelContinuity,
} from './continuity.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export type { ModelContinuity } from './continuity.ts';
export { retryModelSchema, retryModelReceiptSchema } from './continuity.ts';
export { createMemoryRouteHealth, createModelRouteHealth } from './model-health.ts';
const compatibility = commonCompatibility;
type Runtime = Parameters<typeof createAgentExecutor>[0]['runtime'];
type Transaction = Parameters<Parameters<Runtime['transaction']>[2]>[0];
const rowSchema = z.object({
  id: z.uuid(),
  agent_id: z.uuid(),
  activation_id: z.uuid(),
  definition_revision: z.string(),
  user_id: z.string(),
  membership_id: z.uuid(),
  scope: scopeSchema,
  prompt: z.string(),
  status: chatReceiptSchema.shape.status,
});
type Turn = z.infer<typeof rowSchema>;

async function authorize(tx: AgentTransaction, row: Turn, workspaceId: string, externalGuard?: ExternalRunGuard) {
  const actor = { kind: 'human' as const, userId: row.user_id, membershipId: row.membership_id };
  await currentMember(tx, actor);
  await requireChatInvocation(tx, workspaceId, actor, row.agent_id, row.id, externalGuard);
  await resolveRunProcedures(tx, row.id);
  for (const entry of row.scope) {
    const personal = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_google_integrations')} WHERE id=$1 AND membership_id=$2 AND user_id=$3`,
        [entry.assetId, actor.membershipId, actor.userId],
      )
    ).rowCount;
    if (personal) {
      if (entry.permissions.some(permission => permission !== 'integration.read' && permission !== 'integration.use'))
        throw new AccessDenied();
      await requireGoogleAgentOwner(tx, row.id, 'optional');
    } else
      for (const permission of entry.permissions)
        if (!(await canAccessAsset(tx, { kind: 'agent', runId: row.id }, entry.assetId, permission)))
          throw new AccessDenied();
  }
  return actor;
}
async function definition(tx: AgentTransaction, row: Pick<Turn, 'agent_id' | 'definition_revision'>) {
  return agentDefinitionSchema.parse(
    (
      await tx.client.query(
        `SELECT definition FROM ${relation(tx, 'tf_agent_definitions')} WHERE agent_id=$1 AND revision=$2`,
        [row.agent_id, row.definition_revision],
      )
    ).rows[0]?.definition,
  );
}
const readTokenTools = new Set<string>(['rows.get', 'rows.list', 'rows.summarize', 'rows.resolveReference']);
const callsSchema = z.array(z.object({ call: toolCallSchema, status: z.string(), result: toolResultSchema }));
function boundRuntime(runtime: Runtime, tx: Transaction, workspaceId: string): Runtime {
  return {
    ...runtime,
    transaction: async (workspace, _compatibility, operation) => {
      if (workspace !== workspaceId) throw new AccessDenied();
      return operation(tx);
    },
  };
}

function dispatchInference(infer: (signal: AbortSignal) => Promise<InferenceResult>, timeoutMs: number) {
  const controller = new AbortController();
  const failure = (reason: 'timeout' | 'cancelled' | 'provider-error'): InferenceResult => ({
    kind: 'failure',
    reason,
    status: null,
    retryAfterMs: null,
    actualModel: null,
    requestId: null,
    usage: { kind: 'unknown' },
  });
  const stopped = new Promise<InferenceResult>(resolve =>
    controller.signal.addEventListener(
      'abort',
      () => resolve(failure(controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled')),
      { once: true },
    ),
  );
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const request = Promise.resolve()
    .then(() => (controller.signal.aborted ? failure('cancelled') : infer(controller.signal)))
    .catch(() => failure('provider-error'));
  const result = Promise.race([request, stopped]).finally(() => clearTimeout(timer));
  return {
    request,
    result,
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      controller.abort('cancelled');
    },
  };
}

export function createAgentChat(
  runtime: Runtime,
  model: ModelContinuity | null,
  integrations?: Parameters<typeof createAgentExecutor>[0]['integrations'],
  google?: GoogleOperationsFactory,
  externalGuard?: ExternalRunGuard,
  slack?: SlackActionsFactory,
) {
  const executor = createAgentExecutor({
    runtime,
    telemetryRuntime: externalGuard ? 'slack' : 'chat',
    ...(integrations ? { integrations } : {}),
    ...(google ? { google } : {}),
    externalGuard,
    slack,
  });
  async function submit(workspaceId: string, user: string, agentId: string, value: unknown) {
    const input = chatInputSchema.parse(value);
    if (!model) throw new AgentError('model-not-configured', 503);
    return runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, user);
      if (!externalGuard?.record) await requireChatInvocation(tx, workspaceId, actor, agentId, input.id, externalGuard);
      await requireHumanRun(tx, input.id);
      await requireExternalRun(tx, workspaceId, input.id, externalGuard);
      const previous = (
        await tx.client.query(
          `SELECT r.*, t.prompt, t.status FROM ${relation(tx, 'tf_agent_chat_turns')} t JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=t.id WHERE t.id=$1`,
          [input.id],
        )
      ).rows[0];
      if (previous) {
        const row = rowSchema.parse(previous);
        if (
          row.membership_id !== actor.membershipId ||
          row.user_id !== actor.userId ||
          row.agent_id !== agentId ||
          row.activation_id !== input.activationId ||
          row.prompt !== input.prompt ||
          canonicalJson(row.scope) !== canonicalJson(input.scope)
        )
          throw new AgentError('chat-identity-conflict');
        if (externalGuard?.record)
          await requireChatInvocation(tx, workspaceId, actor, agentId, input.id, externalGuard);
        return { id: row.id, revision: row.definition_revision, status: row.status };
      }
      const count = z
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_agent_chat_turns')} t JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=t.id WHERE r.membership_id=$1 AND t.created_at > now()-interval '1 hour'`,
              [actor.membershipId],
            )
          ).rows[0]?.count,
        );
      if (count >= 100) throw new AgentError('chat-hourly-limit', 400);
      const activation = (
        await tx.client.query(
          `SELECT a.definition_revision FROM ${relation(tx, 'tf_agent_activations')} a JOIN ${relation(tx, 'tf_agents')} g ON g.id=a.agent_id WHERE a.id=$1 AND a.agent_id=$2 AND a.revoked_at IS NULL AND g.enabled`,
          [input.activationId, agentId],
        )
      ).rows[0];
      if (!activation) throw new AccessDenied();
      const revision = z.string().parse(activation.definition_revision);
      const selected = await definition(tx, { agent_id: agentId, definition_revision: revision });
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope) VALUES ($1,$2,$3,$4,'delegated',$5,$6,$7)`,
        [
          input.id,
          agentId,
          input.activationId,
          revision,
          actor.userId,
          actor.membershipId,
          JSON.stringify(input.scope),
        ],
      );
      if (externalGuard?.record) {
        await externalGuard.record(tx, workspaceId, actor, agentId, input.id);
        await requireChatInvocation(tx, workspaceId, actor, agentId, input.id, externalGuard);
      }
      await resolveRunProcedures(tx, input.id);
      await tx.client.query(`INSERT INTO ${relation(tx, 'tf_agent_chat_turns')} (id,prompt) VALUES ($1,$2)`, [
        input.id,
        input.prompt,
      ]);
      await admitGeneration(tx, model, workspaceId, input.id, agentId, revision, selected.modelFamilyId, 0);
      return { id: input.id, revision, status: 'pending' as const };
    });
  }
  async function read(workspaceId: string, user: string, agentId: string, id: string) {
    return runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, user);
      await requireHumanRun(tx, z.uuid().parse(id));
      await requireExternalRun(tx, workspaceId, id, externalGuard);
      await requireChatInvocation(tx, workspaceId, actor, agentId, id, externalGuard);
      const raw = (
        await tx.client.query(
          `SELECT r.*,t.prompt,t.status,t.decision FROM ${relation(tx, 'tf_agent_chat_turns')} t JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=t.id WHERE t.id=$1`,
          [z.uuid().parse(id)],
        )
      ).rows[0];
      const row = rowSchema.optional().parse(raw);
      if (!row || row.agent_id !== agentId || row.user_id !== actor.userId || row.membership_id !== actor.membershipId)
        throw new AccessDenied();
      const receipt = { id, revision: row.definition_revision, status: row.status };
      try {
        await authorize(tx, row, workspaceId, externalGuard);
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
        return {
          ...receipt,
          status: 'failed' as const,
          text: null,
          call: null,
          execution: { status: 'blocked' as const, result: null },
        };
      }
      const decision = raw.decision ? modelDecisionSchema.parse(raw.decision) : null;
      let execution = null;
      if (decision?.kind === 'tool') {
        const callId = z
          .uuid()
          .parse(
            (
              await tx.client.query(
                `SELECT id FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1`,
                [id],
              )
            ).rows[0]?.id,
          );
        try {
          execution = await createAgentExecutor({
            runtime: boundRuntime(runtime, tx, workspaceId),
            externalGuard,
          }).readResult({ workspaceId, runId: id, callId }, actor);
        } catch (error) {
          if (!(error instanceof AccessDenied)) throw error;
          return {
            ...receipt,
            status: 'failed' as const,
            text: null,
            call: null,
            execution: { status: 'blocked' as const, result: null },
          };
        }
      }
      const activityStatus =
        decision?.kind === 'tool' && execution
          ? await storedToolStatus(tx, {
              id,
              tool: decision.call.tool,
              status: execution.status,
              output: execution.result,
            })
          : undefined;
      const generation = await latestGeneration(tx, id);
      const attempts = z
        .array(modelAttemptReceiptSchema)
        .parse(
          (
            await tx.client.query(
              `SELECT id,ordinal,role,status,resolution,usage,cost,outcome FROM ${relation(tx, 'tf_model_attempts')} WHERE run_id=$1 AND generation=$2 ORDER BY ordinal`,
              [id, generation?.generation ?? 0],
            )
          ).rows,
        );
      return {
        ...receipt,
        ...(activityStatus ? { activityStatus } : {}),
        ...(decision?.kind === 'tool'
          ? { presentation: await storedToolPresentation(tx, actor, decision.call.tool, decision.call, undefined, id) }
          : {}),
        text: decision?.text ?? null,
        call: decision?.kind === 'tool' ? decision.call : null,
        execution,
        model: generation
          ? {
              generation: generation.generation,
              status: generation.status,
              failure: generation.failure,
              deadline: generation.deadline.toISOString(),
              winner: generation.winner,
              bundleId: generation.binding.bundleId,
              activationRevision: generation.binding.activationRevision,
              preferred: modelAttemptReceiptSchema.shape.resolution.parse(generation.binding.primary),
              attempts,
            }
          : null,
      };
    });
  }
  async function retry(workspaceId: string, user: string, agentId: string, id: string, value: unknown) {
    const input = retryModelSchema.parse(value);
    if (!model) throw new AgentError('model-not-configured', 503);
    return runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, user);
      const raw = (
        await tx.client.query(
          `SELECT r.*,t.prompt,t.status,t.decision FROM ${relation(tx, 'tf_agent_chat_turns')} t JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=t.id WHERE t.id=$1 FOR UPDATE OF t`,
          [z.uuid().parse(id)],
        )
      ).rows[0];
      await requireExternalRun(tx, workspaceId, id);
      const row = rowSchema.optional().parse(raw);
      if (!row || row.agent_id !== agentId || row.user_id !== actor.userId || row.membership_id !== actor.membershipId)
        throw new AccessDenied();
      await requireAgentPermission(tx, actor, agentId, 'invoke');
      const command = { ...input, runId: id, agentId };
      const previous = await previousRetry(tx, actor.membershipId, command, input.requestId);
      if (previous) return previous;
      await authorize(tx, row, workspaceId);
      const generation = await latestGeneration(tx, id);
      if (
        !generation ||
        generation.generation !== input.expectedGeneration ||
        generation.status !== 'failed' ||
        row.status !== 'failed' ||
        raw.decision ||
        generation.winner ||
        (await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1`, [id])).rowCount
      )
        throw new AgentError('model-retry-conflict');
      const selected = await definition(tx, row);
      await admitGeneration(
        tx,
        model,
        workspaceId,
        id,
        agentId,
        row.definition_revision,
        selected.modelFamilyId,
        generation.generation + 1,
      );
      const receipt = { requestId: input.requestId, runId: id, generation: generation.generation + 1 };
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_model_retry_commands')} (membership_id,request_id,input,receipt) VALUES ($1,$2,$3,$4)`,
        [actor.membershipId, input.requestId, command, receipt],
      );
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status='pending',lease_id=NULL,lease_until=NULL WHERE id=$1`,
        [id],
      );
      return receipt;
    });
  }
  async function processTurn(workspaceId: string, id: string) {
    const selected = await runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      await requireHumanRun(tx, id);
      await requireExternalRun(tx, workspaceId, id, externalGuard);
      const raw = (
        await tx.client.query(
          `SELECT r.*,t.prompt,t.status,t.decision FROM ${relation(tx, 'tf_agent_chat_turns')} t JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=t.id WHERE t.id=$1 FOR UPDATE OF t`,
          [id],
        )
      ).rows[0];
      const row = rowSchema.optional().parse(raw);
      if (!row || ['answered', 'failed'].includes(row.status)) return null;
      if (row.status === 'tool') {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET attempted_at=clock_timestamp() WHERE id=$1`,
          [id],
        );
        return { kind: 'tool' as const };
      }
      const generation = await latestGeneration(tx, id);
      if (!generation) {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status='failed',lease_until=NULL WHERE id=$1 AND decision IS NULL`,
          [id],
        );
        return null;
      }
      if (!model) {
        await failGeneration(tx, generation, 'model-not-configured');
        return null;
      }
      try {
        await authorize(tx, row, workspaceId, externalGuard);
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
        await failGeneration(tx, generation, 'authority-revoked');
        return null;
      }
      const destinations = slack
        ? (
            await tx.client.query(
              `SELECT id,name,channel FROM ${relation(tx, 'tf_slack_destinations')} WHERE enabled AND id=ANY($1::uuid[]) ORDER BY id`,
              [
                row.scope
                  .filter(entry => entry.permissions.some(permission => permission.startsWith('slack.')))
                  .map(entry => entry.assetId),
              ],
            )
          ).rows
        : [];
      const results = callsSchema.parse(
        (
          await tx.client.query(
            `SELECT call,status,result FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1 ORDER BY sequence`,
            [id],
          )
        ).rows,
      );
      const request = destinations.length
        ? `${row.prompt}\n\nServer-configured Slack destinations. These identifiers do not grant permission.\n${JSON.stringify(destinations)}`
        : row.prompt;
      const resolved = await definition(tx, row);
      const input = {
        prompt: results.length ? JSON.stringify({ request, results }) : request,
        scope: row.scope,
        definition: resolved,
        procedures: await resolveRunProcedures(tx, row.id),
        ...(externalGuard ? { runtime: 'slackChannel' as const } : {}),
        ...(!externalGuard && (await imageGenerationOffered(workspaceId, resolved.tools))
          ? { images: true as const }
          : {}),
      };
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET attempted_at=clock_timestamp() WHERE id=$1`,
        [id],
      );
      const claim = await claimAttempt(tx, model, workspaceId, generation, input);
      return claim ? { kind: 'select' as const, row, generation, input, ...claim } : null;
    });
    if (!selected) return;
    let executeTool = selected.kind === 'tool';
    if (selected.kind === 'select' && model) {
      const inFlight: { dispatch?: ReturnType<typeof dispatchInference> } = {};
      let dispatched;
      try {
        dispatched = await runtime.transaction(workspaceId, compatibility, async tx => {
          await lockAuthorization(tx);
          await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_chat_turns')} WHERE id=$1 FOR UPDATE`, [id]);
          const generation = await latestGeneration(tx, id);
          if (
            !generation ||
            generation.generation !== selected.generation.generation ||
            generation.status !== 'running'
          )
            return null;
          if (
            !(
              await tx.client.query(
                `SELECT 1 FROM ${relation(tx, 'tf_model_attempts')} WHERE id=$1 AND status='running' AND lease_until>clock_timestamp()`,
                [selected.attempt.id],
              )
            ).rowCount
          )
            return null;
          try {
            await authorize(tx, selected.row, workspaceId, externalGuard);
            await requireExternalRun(tx, workspaceId, id, externalGuard);
          } catch (error) {
            if (!(error instanceof AccessDenied)) throw error;
            await failGeneration(tx, generation, 'authority-revoked');
            return null;
          }
          if (
            !(await permitted(tx, model, workspaceId, generation, selected.attempt.resolution, selected.attempt.role))
          ) {
            await failGeneration(tx, generation, 'policy-revoked');
            return null;
          }
          const timeoutMs = Math.min(45000, selected.dispatchDeadline - Date.now());
          if (timeoutMs <= 0) {
            await failGeneration(tx, generation, 'deadline');
            return null;
          }
          inFlight.dispatch = dispatchInference(
            signal => model.infer(selected.attempt.resolution, selected.input, timeoutMs, signal),
            timeoutMs,
          );
          return inFlight.dispatch;
        });
      } catch (error) {
        inFlight.dispatch?.cancel();
        await model.health.finish(selected.attempt.resolution, selected.attempt.id, null, null);
        throw error;
      }
      if (!dispatched) {
        await runtime.transaction(workspaceId, compatibility, tx => settleCredits(tx, selected.attempt.id, '0'));
        await model.health.finish(selected.attempt.resolution, selected.attempt.id, null, null);
        return;
      }
      const result = await dispatched.result;
      let metered: MeteredUsage | null = null;
      const meter = (usage: MeteredUsage) => {
        metered = usage;
      };
      await runtime.transaction(workspaceId, compatibility, async tx => {
        metered = null;
        await lockAuthorization(tx);
        await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_chat_turns')} WHERE id=$1 FOR UPDATE`, [id]);
        const generation = await latestGeneration(tx, id);
        if (!generation) return;
        if (generation.generation !== selected.generation.generation) {
          await settleAttempt(tx, model, selected.generation, selected.attempt, result, meter);
          return;
        }
        if (!(await settleAttempt(tx, model, generation, selected.attempt, result, meter))) return;
        if (
          !(await permitted(tx, model, workspaceId, generation, selected.attempt.resolution, selected.attempt.role))
        ) {
          await failGeneration(tx, generation, 'policy-revoked');
          return;
        }
        if (result.kind === 'failure') return;
        await tx.client.query('SAVEPOINT model_decision');
        try {
          const actor = await authorize(tx, selected.row, workspaceId, externalGuard);
          await requireExternalRun(tx, workspaceId, id, externalGuard);
          if (
            !(await permitted(tx, model, workspaceId, generation, selected.attempt.resolution, selected.attempt.role))
          )
            throw new AccessDenied();
          const spending = await latestGeneration(tx, id);
          if (
            !spending ||
            BigInt(spending.spent_pico_usd) > BigInt(spending.budget_pico_usd) ||
            BigInt(spending.spent_pico_usd) > BigInt(await model.budgetPicoUsd(workspaceId))
          )
            throw new AgentError('model-budget-exceeded');
          const decision = modelDecisionSchema.parse(result.decision);
          if (decision.kind === 'clarify' || decision.kind === 'propose') throw new AgentError('model-retry-conflict');
          let persistedDecision = decision;
          if (decision.kind === 'tool') {
            const sequence = z
              .number()
              .parse(
                (
                  await tx.client.query(
                    `SELECT COALESCE(max(sequence)+1,0)::integer AS sequence FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1`,
                    [id],
                  )
                ).rows[0]?.sequence,
              );
            await createAgentExecutor({ runtime: boundRuntime(runtime, tx, workspaceId), externalGuard }).queueCall(
              workspaceId,
              actor,
              { runId: id, callId: randomUUID(), sequence, call: decision.call },
            );
          } else if (decision.kind === 'tools') {
            const sequence = z
              .number()
              .parse(
                (
                  await tx.client.query(
                    `SELECT COALESCE(max(sequence)+1,0)::integer AS sequence FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1`,
                    [id],
                  )
                ).rows[0]?.sequence,
              );
            const calls = [];
            for (const [index, selectedCall] of decision.calls.entries()) {
              const callId = randomUUID();
              await createAgentExecutor({ runtime: boundRuntime(runtime, tx, workspaceId), externalGuard }).queueCall(
                workspaceId,
                actor,
                { runId: id, callId, sequence: sequence + index, call: selectedCall.call },
              );
              calls.push({ ...selectedCall, id: callId });
            }
            persistedDecision = { ...decision, calls };
          }
          const updated = await tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status=$3,decision=$4,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='selecting' AND lease_until>clock_timestamp() AND clock_timestamp()<$5`,
            [
              id,
              selected.attempt.id,
              decision.kind === 'tool' || decision.kind === 'tools' ? 'tool' : 'answered',
              JSON.stringify(persistedDecision),
              generation.deadline,
            ],
          );
          if (!updated.rowCount) throw new AgentError('model-lease-expired');
          await recordWinner(tx, generation, selected.attempt);
          await tx.client.query('RELEASE SAVEPOINT model_decision');
          executeTool = decision.kind === 'tool' || decision.kind === 'tools';
        } catch (error) {
          await tx.client.query('ROLLBACK TO SAVEPOINT model_decision');
          await failGeneration(
            tx,
            generation,
            error instanceof AccessDenied ? 'authority-revoked' : 'decision-rejected',
          );
        }
      });
      reportUsage(workspaceId, metered);
      if (dispatched.signal.aborted)
        void dispatched.request
          .then(async late => {
            let lateUsage: MeteredUsage | null = null;
            await runtime.transaction(workspaceId, compatibility, async tx => {
              lateUsage = null;
              await lockAuthorization(tx);
              await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_chat_turns')} WHERE id=$1 FOR UPDATE`, [
                id,
              ]);
              await latestGeneration(tx, id);
              await settleAttempt(tx, model, selected.generation, selected.attempt, late, usage => {
                lateUsage = usage;
              });
            });
            reportUsage(workspaceId, lateUsage);
          })
          .catch(() => undefined);
      await model.health.finish(
        selected.attempt.resolution,
        selected.attempt.id,
        result.kind === 'failure' ? result.reason : null,
        result.kind === 'failure' ? result.retryAfterMs : null,
      );
    }
    if (!executeTool) return;
    const execution = await runtime.transaction(workspaceId, compatibility, async tx => {
      const raw = (
        await tx.client.query(`SELECT decision FROM ${relation(tx, 'tf_agent_chat_turns')} WHERE id=$1`, [id])
      ).rows[0];
      const decision = modelDecisionSchema.parse(raw?.decision);
      if (decision.kind === 'tool') {
        const callId = z
          .uuid()
          .parse(
            (
              await tx.client.query(
                `SELECT id FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1`,
                [id],
              )
            ).rows[0]?.id,
          );
        return { decision, callIds: [callId] };
      }
      if (decision.kind !== 'tools') throw new AgentError('model-retry-conflict');
      return { decision, callIds: decision.calls.map(call => z.uuid().parse(call.id)) };
    });
    let statuses: ExecutionStatus[];
    try {
      statuses =
        execution.callIds.length === 1
          ? [await executor.execute({ workspaceId, runId: id, callId: execution.callIds[0]! })]
          : await executor.executeBatch(execution.callIds.map(callId => ({ workspaceId, runId: id, callId })));
    } catch {
      return;
    }
    if (statuses.some(status => status === 'waiting')) return;
    const continued = await runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      const raw = (
        await tx.client.query(
          `SELECT r.*,t.prompt,t.status,t.decision FROM ${relation(tx, 'tf_agent_chat_turns')} t JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=t.id WHERE t.id=$1 FOR UPDATE OF t`,
          [id],
        )
      ).rows[0];
      const row = rowSchema.optional().parse(raw);
      const decision = raw?.decision ? modelDecisionSchema.parse(raw.decision) : null;
      const results = callsSchema.parse(
        (
          await tx.client.query(
            `SELECT call,status,result FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE id=ANY($1::uuid[]) AND run_id=$2 ORDER BY sequence`,
            [execution.callIds, id],
          )
        ).rows,
      );
      const parallel = decision?.kind === 'tools';
      const single = results[0];
      if (
        !model ||
        !row ||
        row.status !== 'tool' ||
        !decision ||
        results.length !== execution.callIds.length ||
        (!parallel &&
          (decision.kind !== 'tool' ||
            !single ||
            (statuses[0] !== 'completed' && canonicalJson(single.result) !== canonicalJson(recordConflict)) ||
            (!readTokenTools.has(single.call.tool) && canonicalJson(single.result) !== canonicalJson(recordConflict))))
      )
        return false;
      const generation = await latestGeneration(tx, id);
      if (!generation) return false;
      const selected = await definition(tx, row);
      await admitGeneration(
        tx,
        model,
        workspaceId,
        id,
        row.agent_id,
        row.definition_revision,
        selected.modelFamilyId,
        generation.generation + 1,
      );
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status='pending',decision=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1 AND status='tool'`,
        [id],
      );
      return true;
    });
    if (!continued)
      await runtime.transaction(workspaceId, compatibility, tx =>
        tx.client.query(`UPDATE ${relation(tx, 'tf_agent_chat_turns')} SET status=$2 WHERE id=$1 AND status='tool'`, [
          id,
          statuses.every(status => status === 'completed') ? 'answered' : 'failed',
        ]),
      );
  }
  async function pending(workspaceId: string) {
    return runtime.transaction(workspaceId, commonCompatibility, async tx => {
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT t.id FROM ${relation(tx, 'tf_agent_chat_turns')} t WHERE NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_slack_agent_turns')} s WHERE s.run_id=t.id) AND (t.status='tool' OR (t.status='pending' AND (NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_model_generations')} g WHERE g.run_id=t.id) OR EXISTS (SELECT 1 FROM ${relation(tx, 'tf_model_generations')} g WHERE g.run_id=t.id AND g.status='pending' AND (g.next_at<=clock_timestamp() OR g.deadline<=clock_timestamp())))) OR (t.status='selecting' AND t.lease_until<clock_timestamp())) ORDER BY t.attempted_at NULLS FIRST,t.created_at,t.id LIMIT 5`,
            )
          ).rows,
        )
        .map(row => row.id);
    });
  }
  return { submit, read, retry, processTurn, pending, configured: model !== null };
}
