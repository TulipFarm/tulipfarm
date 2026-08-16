import {
  type CompiledState,
  type ForeachProgress,
  initForeachProgress,
  initParallelProgress,
  joinForeach,
  joinParallel,
  type ParallelProgress,
  planForeach,
  planParallel,
  RoutineStepError,
  resolveForeachItems,
  type StepOutcome,
  settleForeachItem,
  settleParallelBranch,
  stepRepeat,
} from "@tulipfarm/run-kernel";
import type { PersistedState } from "@tulipfarm/storage";
import { type ChainOutcome, RoutineExecutionRefusal, type StateOutputs } from "./execution-support";

/**
 * The three State kinds that run a body more than once: `parallel`, `foreach`, `repeat_until`.
 *
 * None of them holds its progress in memory. Each round re-plans from what the durable
 * occurrence-key rows already say, dispatches only the units the plan names, and settles the
 * result back into the same progress value — so a replay after a crash resumes at the unit it
 * reached instead of re-running the ones that already settled.
 */

/** What fan-out needs from the executor; the executor keeps ownership of scheduling and chains. */
export interface FanOutContext {
  /** Durable State rows this attempt has seen, keyed by occurrence key. */
  readonly persisted: Map<string, PersistedState>;
  readonly now: () => Date;
  /** Schedules a unit's first State under its occurrence key, then walks that unit's chain. */
  readonly runUnit: (
    bodyName: string,
    parentKey: string,
    unit: string,
    extras: Readonly<Record<string, unknown>>,
    outputs: StateOutputs,
    depth: number
  ) => Promise<ChainOutcome>;
}

/** Fan-out/loop units replay from durable occurrence-key rows, not memory. */
export async function runComposite(
  ctx: FanOutContext,
  state: CompiledState,
  key: string,
  scope: Readonly<Record<string, unknown>>,
  outputs: StateOutputs,
  depth: number
): Promise<StepOutcome | ChainOutcome | null> {
  if (state.type === "parallel") return runParallel(ctx, state, key, outputs, depth);
  if (state.type === "foreach") return runForeach(ctx, state, key, scope, outputs, depth);
  if (state.type === "repeat_until") return runRepeat(ctx, state, key, scope, outputs, depth);
  throw new RoutineExecutionRefusal("unsupported_state", state.name);
}

async function runParallel(
  ctx: FanOutContext,
  state: CompiledState,
  key: string,
  outputs: StateOutputs,
  depth: number
): Promise<StepOutcome | ChainOutcome | null> {
  let progress: ParallelProgress = initParallelProgress(state);

  for (;;) {
    const plan = planParallel(state, progress);
    if (plan.dispatch.length === 0) break;
    for (const branch of plan.dispatch) {
      const settled = await ctx.runUnit(branch, key, branch, {}, outputs, depth);
      if (settled === "cancelled" || settled === "needs_reconciliation") return settled;
      progress = settleParallelBranch(progress, branch, unitStatus(settled));
    }
  }

  return join(joinParallel(state, progress), state);
}

async function runForeach(
  ctx: FanOutContext,
  state: CompiledState,
  key: string,
  scope: Readonly<Record<string, unknown>>,
  outputs: StateOutputs,
  depth: number
): Promise<StepOutcome | ChainOutcome | null> {
  if (state.body === null) throw new RoutineStepError("missing_body", state.name);
  const items = resolveForeachItems(state, scope);
  let progress: ForeachProgress = initForeachProgress(state, items);

  for (;;) {
    const plan = planForeach(state, progress);
    if (plan.dispatch.length === 0) break;
    for (const index of plan.dispatch) {
      const settled = await ctx.runUnit(
        state.body,
        key,
        String(index),
        { item: items[index] },
        outputs,
        depth
      );
      if (settled === "cancelled" || settled === "needs_reconciliation") return settled;
      progress = settleForeachItem(state, progress, index, unitStatus(settled));
    }
  }

  return join(joinForeach(state, progress), state);
}

/** Bounded loops recover iteration count from rows and elapsed time from State `startedAt`. */
async function runRepeat(
  ctx: FanOutContext,
  state: CompiledState,
  key: string,
  scope: Readonly<Record<string, unknown>>,
  outputs: StateOutputs,
  depth: number
): Promise<StepOutcome | ChainOutcome | null> {
  const row = ctx.persisted.get(key);
  const startedAtMs = Date.parse(row?.startedAt ?? ctx.now().toISOString());
  let iterations = 0;

  for (;;) {
    const loopScope = { ...scope, loop: { iteration: iterations } };
    const decision = stepRepeat(state, { iterations, startedAtMs }, loopScope, ctx.now().getTime());
    if (decision.kind === "exit") return decision.outcome;

    const settled = await ctx.runUnit(
      decision.target,
      key,
      String(decision.iteration),
      { loop: { iteration: decision.iteration } },
      outputs,
      depth
    );
    if (settled === "succeeded") {
      iterations += 1;
      continue;
    }
    return settled === "waiting" ? null : settled;
  }
}

/** Refuses joins that require cancelling live-timer units this executor cannot cancel. */
function join(
  decision: ReturnType<typeof joinParallel>,
  state: CompiledState
): StepOutcome | ChainOutcome | null {
  if (decision.kind === "pending") return null;
  if (decision.kind === "failed") return "failed";
  if (decision.cancel.length > 0) {
    throw new RoutineExecutionRefusal("unsupported_join", state.name);
  }
  return decision.outcome;
}

/** A unit parked on a wait is still running, not settled — its join stays pending. */
function unitStatus(outcome: ChainOutcome): "succeeded" | "failed" | "running" {
  if (outcome === "succeeded") return "succeeded";
  if (outcome === "failed") return "failed";
  return "running";
}
