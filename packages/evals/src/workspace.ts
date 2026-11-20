import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, resolveHuman, type HumanActor } from '@tulipfarm/access';
import {
  calculateUsageCost,
  isPlanProvider,
  reserveModelCost,
  usageTokenCounts,
  type ResolvedModel,
} from '@tulipfarm/config';
import { creditUnitsForProviderCost, recordUsage } from '@tulipfarm/extensions';
import {
  evalReadAdmitted,
  relation,
  requireAgentPermission,
  savedAgentForEval,
  savedAgentRevision,
  withHuman,
} from '@tulipfarm/agents/eval-access';
import {
  inferDecision,
  inferWithSystem,
  isPlanRoute,
  type InferenceRoute,
  type InferenceUsage,
} from '@tulipfarm/agents/inference';
import { modelFamilyEnabled } from '@tulipfarm/agents/model-availability';
import type { ModelEnvironment } from '@tulipfarm/agents/model-environment';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { taskInstructions } from '@tulipfarm/agents/task-runtime';
import { readOnlyCall } from '@tulipfarm/agents/tools';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  CreditsExhausted,
  reserveCredits,
  settleCredits,
  settleCreditsAtReservation,
} from '@tulipfarm/workspace-storage/credits';
import { createAgentDriver } from './agent-driver.ts';
import { createCaps } from './caps.ts';
import type { JudgeModel } from './checks.ts';
import {
  caseResultSchema,
  emptyUsage,
  evalCaseInputSchema,
  evalLimits,
  evalModelSummarySchema,
  evalRunStatuses,
  runRequestSchema,
  usageSchema,
  workspaceEvalErrorCodes,
  type CaseResult,
  type WorkspaceEvalErrorCode,
  type EvalCase,
  type Usage,
} from './contracts.ts';
import type { EvalToolCall } from './effects.ts';
import { runEvals } from './runner.ts';

export {
  runRequestSchema,
  workspaceEvalCaseSchema,
  workspaceEvalErrorCodes,
  workspaceEvalEstimateSchema,
  workspaceEvalRunDetailSchema,
  workspaceEvalRunSchema,
  workspaceEvalSetSchema,
  type RunRequest,
  type WorkspaceEvalErrorCode,
} from './contracts.ts';

type Runtime = Parameters<typeof withHuman>[0];
type Transaction = Parameters<Parameters<typeof withHuman>[4]>[0];

/** Workspace storage versions that have the eval tables. */
export const evalCompatibility = Object.freeze({ minimum: 92, maximum: commonCompatibility.maximum });

export class WorkspaceEvalError extends Error {
  readonly code: WorkspaceEvalErrorCode;
  readonly status: number;
  constructor(code: WorkspaceEvalErrorCode) {
    super(code);
    this.code = code;
    this.status = workspaceEvalErrorCodes[code];
  }
}

type RunRequest = z.input<typeof runRequestSchema>;

const runRowSchema = z.object({
  id: z.uuid(),
  agent_id: z.uuid(),
  membership_id: z.uuid(),
  user_id: z.string(),
  definition_revision: z.string(),
  models: z.array(z.string()),
  judge_model: z.string(),
  repeats: z.number().int(),
  case_ids: z.array(z.uuid()),
  status: z.enum(evalRunStatuses),
  stop_reason: z.string().nullable(),
  estimate_pico_usd: z.coerce.number(),
  agent_usage: usageSchema.or(z.object({}).transform(emptyUsage)),
  judge_usage: usageSchema.or(z.object({}).transform(emptyUsage)),
  summary: z.array(evalModelSummarySchema).nullable(),
  created_at: z.date(),
  started_at: z.date().nullable(),
  finished_at: z.date().nullable(),
});
type RunRow = z.infer<typeof runRowSchema>;
const caseRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  body: z.record(z.string(), z.unknown()),
  created_at: z.date(),
  updated_at: z.date(),
});

/** Average shape of one agent reply and one judge grade, used only for the estimate shown before a run. */
const estimateShape = { decisions: 4, decisionInput: 8000, decisionOutput: 800, judgeInput: 3000, judgeOutput: 400 };
/** Output tokens one agent decision or judge grade may use. */
const outputTokens = 8192;
const leaseMs = 10 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);
const credits = (picoUsd: number | bigint) => Number(creditUnitsForProviderCost(BigInt(picoUsd))) / 1_000_000_000_000;

function viewCase(row: z.infer<typeof caseRowSchema>) {
  return {
    ...evalCaseInputSchema.parse({ ...row.body, name: row.name }),
    id: row.id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export type WorkspaceEvalCase = ReturnType<typeof viewCase>;

function viewRun(row: RunRow, current: string | null) {
  return {
    id: row.id,
    startedBy: row.membership_id,
    status: row.status,
    stopReason: row.stop_reason,
    models: row.models,
    judgeModel: row.judge_model,
    repeats: row.repeats,
    caseCount: row.case_ids.length,
    estimateCredits: credits(row.estimate_pico_usd),
    agentCredits: credits(row.agent_usage.picoUsd),
    judgeCredits: credits(row.judge_usage.picoUsd),
    summary: (row.summary ?? []).map(item => ({ ...item, credits: credits(item.picoUsd) })),
    /** The agent's instructions, skills, tools or model changed after this run. */
    agentChanged: current !== null && current !== row.definition_revision,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}
export type WorkspaceEvalRun = ReturnType<typeof viewRun>;

async function canEdit(tx: Transaction, actor: HumanActor, agentId: string) {
  try {
    await requireAgentPermission(tx, actor, agentId, 'edit');
    return true;
  } catch (error) {
    if (error instanceof AccessDenied) return false;
    throw error;
  }
}

/** Requires `permission`, hiding the agent when the member may not see it. */
async function require(tx: Transaction, actor: HumanActor, agentId: string, permission: 'read' | 'edit') {
  try {
    await requireAgentPermission(tx, actor, agentId, permission);
  } catch (error) {
    if (error instanceof AccessDenied) throw new WorkspaceEvalError('not-found');
    throw error;
  }
  const revision = await savedAgentRevision(tx, agentId);
  if (!revision) throw new WorkspaceEvalError('not-found');
  return revision;
}

const tokens = (input: number, output: number) => ({
  kind: 'known' as const,
  tokens: { input, output, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
});
function quoteOf(resolution: ResolvedModel, maxInputTokens: number) {
  return {
    modelId: resolution.modelId,
    pricingRevision: resolution.pricingRevision,
    rates: resolution.rates,
    maxInputTokens: Math.min(maxInputTokens, resolution.route.maxInputTokens),
    maxOutputTokens: Math.min(outputTokens, resolution.route.maxOutputTokens),
    date: today(),
  };
}
function priced(resolution: ResolvedModel, usage: InferenceUsage) {
  if (usage.kind !== 'known') return null;
  const { kind, ...counts } = usage;
  try {
    const cost = calculateUsageCost({
      ...quoteOf(resolution, resolution.route.maxInputTokens),
      usage: { kind, tokens: counts },
    });
    return cost.kind === 'known' ? cost.providerPicoUsd : null;
  } catch {
    return null;
  }
}
const pricedAt = (resolution: ResolvedModel, input: number, output: number) =>
  Number(priced(resolution, { ...tokens(input, output).tokens, kind: 'known' }) ?? 0);

/**
 * Workspace Evals on saved agents: cases, the judge setting, estimates and runs. The API calls everything except
 * `execute`, which the worker calls for a queued run.
 */
export function createWorkspaceEvals(dependencies: {
  runtime: Runtime;
  environment: ModelEnvironment | null;
  eligible: ModelFamilyEligibility;
}) {
  const { runtime, environment } = dependencies;

  /** A catalog model the workspace may use for an eval run. Plan models answer only for one member, so runs refuse them. */
  async function usable(tx: Transaction, workspaceId: string, familyId: string) {
    if (!environment || !(await dependencies.eligible({ workspaceId, modelFamilyId: familyId }))) return null;
    if (!(await modelFamilyEnabled(tx, familyId))) return null;
    const resolution = environment.resolve(familyId);
    const route = resolution && environment.inference(resolution);
    if (!resolution || !route || isPlanRoute(route)) return null;
    return { familyId, resolution, route };
  }

  async function agentModel(tx: Transaction, actor: HumanActor, agentId: string) {
    const agent = await savedAgentForEval(tx, actor, agentId);
    if (!agent) throw new WorkspaceEvalError('not-found');
    return agent.definition.modelFamilyId ?? environment?.defaultFamily ?? null;
  }

  async function judgeModel(tx: Transaction, actor: HumanActor, agentId: string) {
    const set = (
      await tx.client.query(`SELECT judge_model FROM ${relation(tx, 'tf_agent_eval_sets')} WHERE agent_id=$1`, [
        agentId,
      ])
    ).rows[0];
    return (set?.judge_model as string | null | undefined) ?? (await agentModel(tx, actor, agentId));
  }

  async function ensureSet(tx: Transaction, agentId: string) {
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_eval_sets')} (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING`,
      [agentId],
    );
    await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_agent_eval_sets')} WHERE agent_id=$1 FOR UPDATE`, [
      agentId,
    ]);
  }

  async function cases(tx: Transaction, agentId: string) {
    return z
      .array(caseRowSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT id,name,body,created_at,updated_at FROM ${relation(tx, 'tf_agent_eval_cases')} WHERE agent_id=$1 ORDER BY created_at,id`,
            [agentId],
          )
        ).rows,
      )
      .map(viewCase);
  }

  async function plan(tx: Transaction, workspaceId: string, actor: HumanActor, agentId: string, request: RunRequest) {
    const parsed = runRequestSchema.parse(request);
    const all = await cases(tx, agentId);
    const selected = parsed.caseIds ? all.filter(item => parsed.caseIds!.includes(item.id)) : all;
    if (!selected.length || (parsed.caseIds && selected.length !== new Set(parsed.caseIds).size))
      throw new WorkspaceEvalError('no-cases');
    const own = await agentModel(tx, actor, agentId);
    const models = [...new Set(parsed.models ?? (own ? [own] : []))];
    if (!models.length) throw new WorkspaceEvalError('model-unavailable');
    const replies = selected.length * parsed.repeats * models.length;
    if (replies > evalLimits.repliesPerRun) throw new WorkspaceEvalError('reply-limit');
    const judgeFamily = await judgeModel(tx, actor, agentId);
    const resolved = await Promise.all(models.map(model => usable(tx, workspaceId, model)));
    if (resolved.some(item => !item)) throw new WorkspaceEvalError('model-unavailable');
    const judgeChecks = selected.reduce(
      (sum, item) => sum + item.checks.filter(check => check.kind === 'judge' || check.kind === 'status').length,
      0,
    );
    const judge = judgeChecks && judgeFamily ? await usable(tx, workspaceId, judgeFamily) : null;
    if (judgeChecks && !judge) throw new WorkspaceEvalError('model-unavailable');
    let picoUsd = 0;
    for (const item of resolved)
      picoUsd +=
        selected.length *
        parsed.repeats *
        estimateShape.decisions *
        pricedAt(item!.resolution, estimateShape.decisionInput, estimateShape.decisionOutput);
    if (judge)
      picoUsd +=
        judgeChecks *
        parsed.repeats *
        models.length *
        pricedAt(judge.resolution, estimateShape.judgeInput, estimateShape.judgeOutput);
    return {
      cases: selected,
      models,
      repeats: parsed.repeats,
      judgeModel: judgeFamily ?? models[0]!,
      replies,
      picoUsd: Math.ceil(picoUsd),
    };
  }

  async function runRows(tx: Transaction, agentId: string, where = '', values: unknown[] = []) {
    return z
      .array(runRowSchema)
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'tf_agent_eval_runs')} WHERE agent_id=$1 ${where} ORDER BY created_at DESC, id`,
            [agentId, ...values],
          )
        ).rows,
      );
  }

  return {
    /** The agent's eval cases and judge setting, for anyone who can use the agent. */
    read(workspaceId: string, user: string, agentId: string) {
      return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
        await require(tx, actor, agentId, 'read');
        const set = (
          await tx.client.query(`SELECT judge_model FROM ${relation(tx, 'tf_agent_eval_sets')} WHERE agent_id=$1`, [
            agentId,
          ])
        ).rows[0];
        return {
          canEdit: await canEdit(tx, actor, agentId),
          judgeModel: (set?.judge_model as string | null | undefined) ?? null,
          defaultJudgeModel: await agentModel(tx, actor, agentId),
          limits: evalLimits,
          cases: await cases(tx, agentId),
        };
      });
    },

    createCase(workspaceId: string, user: string, agentId: string, input: unknown) {
      const parsed = evalCaseInputSchema.parse(input);
      return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
        await require(tx, actor, agentId, 'edit');
        await ensureSet(tx, agentId);
        const count = Number(
          (
            await tx.client.query(
              `SELECT count(*)::integer AS count FROM ${relation(tx, 'tf_agent_eval_cases')} WHERE agent_id=$1`,
              [agentId],
            )
          ).rows[0]?.count ?? 0,
        );
        if (count >= evalLimits.casesPerSet) throw new WorkspaceEvalError('case-limit');
        const { name, ...body } = parsed;
        const row = caseRowSchema.parse(
          (
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_agent_eval_cases')} (id,agent_id,name,body,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,body,created_at,updated_at`,
              [randomUUID(), agentId, name, body, actor.membershipId],
            )
          ).rows[0],
        );
        return viewCase(row);
      });
    },

    updateCase(workspaceId: string, user: string, agentId: string, caseId: string, input: unknown) {
      const { name, ...body } = evalCaseInputSchema.parse(input);
      return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
        await require(tx, actor, agentId, 'edit');
        const row = (
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_eval_cases')} SET name=$3, body=$4, updated_at=clock_timestamp() WHERE id=$1 AND agent_id=$2 RETURNING id,name,body,created_at,updated_at`,
            [caseId, agentId, name, body],
          )
        ).rows[0];
        if (!row) throw new WorkspaceEvalError('not-found');
        return viewCase(caseRowSchema.parse(row));
      });
    },

    deleteCase(workspaceId: string, user: string, agentId: string, caseId: string) {
      return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
        await require(tx, actor, agentId, 'edit');
        const deleted = await tx.client.query(
          `DELETE FROM ${relation(tx, 'tf_agent_eval_cases')} WHERE id=$1 AND agent_id=$2`,
          [caseId, agentId],
        );
        if (!deleted.rowCount) throw new WorkspaceEvalError('not-found');
      });
    },

    /** Sets the model that grades judge checks; null returns to the default, the agent's own model. */
    setJudgeModel(workspaceId: string, user: string, agentId: string, judgeModel: string | null) {
      return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
        await require(tx, actor, agentId, 'edit');
        if (judgeModel !== null && !(await usable(tx, workspaceId, judgeModel)))
          throw new WorkspaceEvalError('model-unavailable');
        await ensureSet(tx, agentId);
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_eval_sets')} SET judge_model=$2, updated_at=clock_timestamp() WHERE agent_id=$1`,
          [agentId, judgeModel],
        );
        return { judgeModel };
      });
    },

    /** The replies and credits a run would use, shown before an editor confirms it. */
    estimate(workspaceId: string, user: string, agentId: string, request: RunRequest) {
      return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
        await require(tx, actor, agentId, 'edit');
        const planned = await plan(tx, workspaceId, actor, agentId, request);
        return {
          replies: planned.replies,
          models: planned.models,
          judgeModel: planned.judgeModel,
          credits: credits(planned.picoUsd),
        };
      });
    },

    /** Queues a run. The worker picks it up; an agent has at most one active run. */
    start(workspaceId: string, user: string, agentId: string, request: RunRequest) {
      return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
        const revision = await require(tx, actor, agentId, 'edit');
        await ensureSet(tx, agentId);
        const planned = await plan(tx, workspaceId, actor, agentId, request);
        const active = await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_agent_eval_runs')} WHERE agent_id=$1 AND status IN ('queued','running')`,
          [agentId],
        );
        if (active.rowCount) throw new WorkspaceEvalError('run-active');
        const row = runRowSchema.parse(
          (
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_agent_eval_runs')} (id,agent_id,membership_id,user_id,definition_revision,models,judge_model,repeats,case_ids,status,estimate_pico_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10) RETURNING *`,
              [
                randomUUID(),
                agentId,
                actor.membershipId,
                actor.userId,
                revision,
                planned.models,
                planned.judgeModel,
                planned.repeats,
                planned.cases.map(item => item.id),
                planned.picoUsd,
              ],
            )
          ).rows[0],
        );
        return viewRun(row, revision);
      });
    },

    runs(workspaceId: string, user: string, agentId: string) {
      return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
        const revision = await require(tx, actor, agentId, 'read');
        return (await runRows(tx, agentId)).map(row => viewRun(row, revision));
      });
    },

    /** One run with every case, model and repeat result. */
    run(workspaceId: string, user: string, agentId: string, runId: string) {
      return withHuman(runtime, workspaceId, user, 'read', async (tx, actor) => {
        const revision = await require(tx, actor, agentId, 'read');
        const [row] = await runRows(tx, agentId, 'AND id=$2', [runId]);
        if (!row) throw new WorkspaceEvalError('not-found');
        const results = (
          await tx.client.query(
            `SELECT case_name,result FROM ${relation(tx, 'tf_agent_eval_results')} WHERE run_id=$1 ORDER BY created_at, case_id, model, repeat`,
            [runId],
          )
        ).rows.map(result => ({
          caseName: z.string().parse(result.case_name),
          ...caseResultSchema.parse(result.result),
        }));
        return { ...viewRun(row, revision), results };
      });
    },

    /** Stops a queued or running run. Results so far are kept. */
    cancel(workspaceId: string, user: string, agentId: string, runId: string) {
      return withHuman(runtime, workspaceId, user, 'write', async (tx, actor) => {
        const revision = await require(tx, actor, agentId, 'edit');
        const row = (
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_eval_runs')} SET status='stopped', stop_reason='cancelled', finished_at=clock_timestamp(), lease_until=NULL WHERE id=$1 AND agent_id=$2 AND status IN ('queued','running') RETURNING *`,
            [runId, agentId],
          )
        ).rows[0];
        if (!row) throw new WorkspaceEvalError('run-finished');
        return viewRun(runRowSchema.parse(row), revision);
      });
    },

    /** Queued runs for the dispatcher, and running runs whose worker stopped renewing their lease, which it fails. */
    async pending(workspaceId: string) {
      return runtime.transaction(workspaceId, evalCompatibility, async tx => {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_eval_runs')} SET status='failed', stop_reason='interrupted', finished_at=clock_timestamp(), lease_until=NULL WHERE status='running' AND lease_until < clock_timestamp()`,
        );
        return (
          await tx.client.query(
            `SELECT id FROM ${relation(tx, 'tf_agent_eval_runs')} WHERE status='queued' ORDER BY created_at LIMIT 20`,
          )
        ).rows.map(row => z.uuid().parse(row.id));
      });
    },

    /**
     * Runs a queued eval run to the end as the member who started it. Read-only calls the agent may make read live data
     * through `tools`; every other call is simulated. Each model request reserves and settles workspace credits.
     */
    async execute(
      workspaceId: string,
      runId: string,
      tools: {
        invoke(
          context: { workspaceId: string; actor: HumanActor; callId: string; signal?: AbortSignal },
          call: EvalToolCall,
        ): Promise<unknown>;
      },
      signal?: AbortSignal,
    ) {
      const transaction = <T>(operation: (tx: Transaction) => Promise<T>) =>
        runtime.transaction(workspaceId, evalCompatibility, operation);
      const fail = (reason: string) =>
        transaction(tx =>
          tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_eval_runs')} SET status='failed', stop_reason=$2, finished_at=clock_timestamp(), lease_until=NULL WHERE id=$1 AND status IN ('queued','running')`,
            [runId, reason],
          ),
        );
      const claimed = await transaction(async tx => {
        const row = (
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_agent_eval_runs')} SET status='running', started_at=clock_timestamp(), lease_until=clock_timestamp()+($2 * interval '1 millisecond') WHERE id=$1 AND status='queued' RETURNING *`,
            [runId, leaseMs],
          )
        ).rows[0];
        return row ? runRowSchema.parse(row) : null;
      });
      if (!claimed) return { status: 'skipped' as const };
      let setup;
      try {
        setup = await transaction(async tx => {
          const actor = await resolveHuman(tx, claimed.user_id);
          if (actor.membershipId !== claimed.membership_id) throw new AccessDenied();
          await requireAgentPermission(tx, actor, claimed.agent_id, 'edit');
          const agent = await savedAgentForEval(tx, actor, claimed.agent_id);
          if (!agent) throw new AccessDenied();
          if (agent.definitionRevision !== claimed.definition_revision) return { changed: true as const };
          const stored = z
            .array(caseRowSchema)
            .parse(
              (
                await tx.client.query(
                  `SELECT id,name,body,created_at,updated_at FROM ${relation(tx, 'tf_agent_eval_cases')} WHERE agent_id=$1 AND id=ANY($2::uuid[])`,
                  [claimed.agent_id, claimed.case_ids],
                )
              ).rows,
            )
            .map(viewCase);
          const ordered = claimed.case_ids.flatMap(id => stored.filter(item => item.id === id));
          const models = await Promise.all(claimed.models.map(model => usable(tx, workspaceId, model)));
          const judge = await usable(tx, workspaceId, claimed.judge_model);
          return { changed: false as const, actor, agent, cases: ordered, models, judge };
        });
      } catch (error) {
        await fail(error instanceof AccessDenied ? 'access-removed' : 'unavailable');
        if (error instanceof AccessDenied) return { status: 'failed' as const };
        throw error;
      }
      if (setup.changed) {
        await fail('agent-changed');
        return { status: 'failed' as const };
      }
      if (!setup.cases.length || setup.models.some(item => !item)) {
        await fail(setup.cases.length ? 'model-unavailable' : 'no-cases');
        return { status: 'failed' as const };
      }
      const { actor, agent } = setup;
      const models = new Map(setup.models.map(item => [item!.familyId, item!]));
      const controller = new AbortController();
      const aborted = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let stopReason: string | null = null;
      const flowId = `agent-eval:${runId}`;

      /** One metered model request: reserve credits for its worst case, call, then settle what it used. */
      async function metered<T>(
        resolution: ResolvedModel,
        inputBytes: number,
        activity: 'agent' | 'other',
        call: () => Promise<{ value: T; usage: InferenceUsage; answered: boolean }>,
      ) {
        const id = randomUUID();
        const quote = quoteOf(resolution, inputBytes + 16_384);
        try {
          await transaction(tx =>
            reserveCredits(tx, {
              id,
              flowId,
              modelId: resolution.modelId,
              agentId: claimed!.agent_id,
              activity,
              providerPicoUsd: reserveModelCost(quote),
              pricingRevision: resolution.pricingRevision,
            }),
          );
        } catch (error) {
          if (error instanceof CreditsExhausted) {
            stopReason = 'credits';
            controller.abort();
          }
          throw error;
        }
        let outcome: Awaited<ReturnType<typeof call>> | undefined;
        try {
          outcome = await call();
          return outcome;
        } finally {
          const usage = outcome?.usage ?? { kind: 'unknown' as const };
          const cost = outcome && !outcome.answered ? '0' : priced(resolution, usage);
          const settled = await transaction(tx =>
            cost === null ? settleCreditsAtReservation(tx, id) : settleCredits(tx, id, cost),
          );
          if (settled)
            void recordUsage({
              ...settled,
              workspaceId,
              ...(usage.kind === 'known' ? usageTokenCounts(usage) : {}),
              at: new Date(),
            });
        }
      }

      const driver = createAgentDriver({
        definition: agent.definition,
        scope: agent.scope,
        procedures: agent.procedures,
        instructions: taskInstructions,
        async decide(model, input, requestSignal) {
          const target = models.get(model)!;
          const route: InferenceRoute = {
            ...target.route,
            maxOutputTokens: Math.min(outputTokens, target.resolution.route.maxOutputTokens),
          };
          const bytes = Buffer.byteLength(JSON.stringify(input));
          return (
            await metered(target.resolution, bytes, 'agent', async () => {
              const result = await inferDecision(route, input, requestSignal);
              return {
                value: result,
                usage: result.usage,
                answered: !(result.kind === 'failure' && result.dispatch === 'not-started'),
              };
            })
          ).value;
        },
        price: (model, usage) => Number(priced(models.get(model)!.resolution, usage) ?? 0),
        isRead: readOnlyCall,
        async live(call) {
          if (!evalReadAdmitted(agent.definition, agent.scope, call))
            throw new Error(`This agent may not call ${call.tool} here.`);
          return tools.invoke({ workspaceId, actor, callId: randomUUID(), signal: aborted }, call);
        },
      });
      const judgeTarget = setup.judge;
      const judge: JudgeModel | undefined = !judgeTarget
        ? undefined
        : async ({ system, user }) => {
            const usage: Usage = emptyUsage();
            const route: InferenceRoute = {
              ...judgeTarget.route,
              maxOutputTokens: Math.min(2048, judgeTarget.resolution.route.maxOutputTokens),
            };
            const bytes = Buffer.byteLength(system) + Buffer.byteLength(user);
            const answer = await metered(judgeTarget.resolution, bytes, 'other', async () => {
              let seen: InferenceUsage = { kind: 'unknown' };
              const text = await inferWithSystem(
                route,
                system,
                [{ role: 'user', text: user }],
                async () => async value => {
                  seen = value;
                },
              );
              return { value: text, usage: seen, answered: true };
            });
            const counts = answer.usage.kind === 'known' ? usageTokenCounts(answer.usage) : null;
            usage.requests = 1;
            usage.inputTokens = counts?.inputTokens ?? 0;
            usage.outputTokens = counts?.outputTokens ?? 0;
            usage.picoUsd = Number(priced(judgeTarget.resolution, answer.usage) ?? 0);
            return { text: answer.value, usage };
          };

      const names = new Map(setup.cases.map(item => [item.id, item.name]));
      const outcome = await runEvals({
        cases: setup.cases satisfies EvalCase[],
        models: claimed.models,
        repeats: claimed.repeats,
        driver,
        ...(judge ? { judge } : {}),
        // The run stops once it has used its estimate, which the editor confirmed.
        caps: createCaps({ maxReplies: evalLimits.repliesPerRun, maxPicoUsd: Math.max(claimed.estimate_pico_usd, 1) }),
        signal: aborted,
        async onResult(result: CaseResult) {
          const current = await transaction(async tx => {
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_agent_eval_results')} (run_id,case_id,model,repeat,case_name,pass,result) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [runId, result.caseId, result.model, result.repeat, names.get(result.caseId), result.pass, result],
            );
            return (
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_eval_runs')} SET lease_until=clock_timestamp()+($2 * interval '1 millisecond') WHERE id=$1 AND status='running' RETURNING id`,
                [runId, leaseMs],
              )
            ).rowCount;
          });
          if (!current) {
            stopReason ??= 'cancelled';
            controller.abort();
          }
        },
      });
      const summary = claimed.models.map(model => {
        const own = outcome.results.filter(result => result.model === model);
        return {
          model,
          passed: own.filter(result => result.pass).length,
          total: own.length,
          picoUsd: own.reduce((sum, result) => sum + result.agentUsage.picoUsd + result.judgeUsage.picoUsd, 0),
          durationMs: own.reduce((sum, result) => sum + result.durationMs, 0),
        };
      });
      const reason =
        stopReason ??
        (outcome.stopped?.reason === 'cap'
          ? outcome.stopped.cap === 'cost'
            ? 'estimate-used'
            : 'cap'
          : outcome.stopped?.reason === 'cancelled'
            ? 'cancelled'
            : null);
      await transaction(async tx => {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_eval_runs')} SET status=$2, stop_reason=$3, agent_usage=$4, judge_usage=$5, summary=$6, finished_at=clock_timestamp(), lease_until=NULL WHERE id=$1 AND status='running'`,
          [
            runId,
            reason ? 'stopped' : 'completed',
            reason,
            outcome.agentUsage,
            outcome.judgeUsage,
            JSON.stringify(summary),
          ],
        );
        // Usage and summary are kept for a run an editor cancelled, too.
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_eval_runs')} SET agent_usage=$2, judge_usage=$3, summary=$4 WHERE id=$1 AND status='stopped' AND summary IS NULL`,
          [runId, outcome.agentUsage, outcome.judgeUsage, JSON.stringify(summary)],
        );
        await tx.client.query(
          `DELETE FROM ${relation(tx, 'tf_agent_eval_runs')} WHERE agent_id=$1 AND status NOT IN ('queued','running') AND id NOT IN (SELECT id FROM ${relation(tx, 'tf_agent_eval_runs')} WHERE agent_id=$1 ORDER BY created_at DESC, id LIMIT $2)`,
          [claimed.agent_id, evalLimits.runsKept],
        );
      });
      return { status: reason ? ('stopped' as const) : ('completed' as const), reason };
    },
  };
}
export type WorkspaceEvals = ReturnType<typeof createWorkspaceEvals>;

/** Background runs have no requesting member, so they may use any selectable catalog model but never a member's plan. */
export function catalogEligibility(environment: ModelEnvironment | null): ModelFamilyEligibility {
  return async ({ modelFamilyId }) => {
    const model = environment?.catalog.model(modelFamilyId);
    return Boolean(
      environment &&
      model?.selectable &&
      !isPlanProvider(model.route.type) &&
      !environment.paused(modelFamilyId) &&
      environment.resolve(modelFamilyId),
    );
  };
}
