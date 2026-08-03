import {
  type ArtifactService,
  type CompiledExpression,
  type CompiledRoutine,
  type CompiledState,
  compileRoutine,
  decideBranch,
  type ForeachProgress,
  type IdentityCeiling,
  initForeachProgress,
  initParallelProgress,
  isTimerWait,
  joinForeach,
  joinParallel,
  type ParallelProgress,
  type PersistedWait,
  planForeach,
  planParallel,
  planTimerWait,
  type RegisterWaitInput,
  RoutineInputResolutionError,
  type RoutineStateScheduler,
  RoutineStepError,
  RUN_EXECUTOR_PRINCIPAL_REF,
  resolveErrorPath,
  resolveForeachItems,
  resolveRoutineStateInput,
  routineOccurrenceKey,
  routineWaitId,
  type StateStatus,
  type StepOutcome,
  settleForeachItem,
  settleParallelBranch,
  stateOutcome,
  stepRepeat,
} from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { PersistedRun, PersistedState, RunStore } from "@tulipfarm/storage";
import type { StateTransitionPort } from "../agent-state";
import type { RunExecutor } from "../executors";
import type { WorkerRoutineDefinitionLoader } from "./definition-loader";

export type RoutineExecutionRefusalCode =
  | "invalid_request_artifact"
  | "missing_state"
  | "unsupported_context"
  | "unsupported_join"
  | "unsupported_state"
  | "unsupported_wait";

/** Payload-safe refusal for a Routine capability this executor does not yet own. */
export class RoutineExecutionRefusal extends Error {
  readonly name = "RoutineExecutionRefusal";

  constructor(
    readonly code: RoutineExecutionRefusalCode,
    readonly state: string
  ) {
    super(`${code}:${state}`);
  }
}

interface RoutineArtifactReader {
  read: ArtifactService["read"];
}

interface RoutineRunStateReader {
  listStates: Pick<RunStore, "listStates">["listStates"];
}

/**
 * Durable-wait surface the executor needs; `@tulipfarm/run-kernel`'s `DurableWaitManager`
 * satisfies it. The executor never redeems a wait — the deadline sweep does — so no resume token
 * is read here.
 */
export interface RoutineWaitPort {
  register(input: RegisterWaitInput): Promise<{ readonly wait: PersistedWait }>;
  find(businessId: string, waitId: string): Promise<PersistedWait | null>;
}

interface RoutineExecutorOptions {
  readonly definitions: Pick<WorkerRoutineDefinitionLoader, "load">;
  readonly artifacts: RoutineArtifactReader;
  readonly runs: RoutineRunStateReader;
  readonly scheduler: Pick<RoutineStateScheduler, "schedule">;
  readonly transitions: StateTransitionPort;
  readonly waits: RoutineWaitPort;
  readonly now?: () => Date;
  readonly identityCeiling?: (run: PersistedRun) => IdentityCeiling;
}

interface ManualRoutineRequest {
  readonly slug: string;
  readonly inputs: Record<string, unknown>;
}

/** How one chain of States — a Run's main line, a fan-out unit, or a loop body — ended. */
type ChainOutcome = "succeeded" | "failed" | "waiting" | "needs_reconciliation" | "cancelled";

type StateOutputs = Record<string, { readonly output: unknown }>;

const CLAIM_PATH: readonly StateStatus[] = ["ready", "claimed", "running"];

/** Expression roots this executor can reconstruct from the Run's immutable request Artifact. */
const SUPPORTED_ROOTS: ReadonlySet<string> = new Set(["input", "states", "item", "loop"]);

/** Deterministic State types with no external effect and no Context this executor cannot build. */
const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "branch",
  "wait",
  "parallel",
  "foreach",
  "repeat_until",
]);

/** Error reference an expired `wait` raises, so an authored `onError` handler can claim it. */
const WAIT_TIMED_OUT = "wait_timed_out";

function defaultIdentityCeiling(run: PersistedRun): IdentityCeiling {
  return {
    principalKind: run.identity.effectiveSubject.kind,
    principalId: run.identity.effectiveSubject.id,
    grants: [],
    maxRiskClass: "low",
  };
}

function artifactId(payloadRef: unknown, state: string): string {
  if (typeof payloadRef !== "string" || !payloadRef.startsWith("artifact:")) {
    throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  }
  const id = payloadRef.slice("artifact:".length);
  if (id.length === 0) throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  return id;
}

function manualRequest(content: Record<string, unknown>, state: string): ManualRoutineRequest {
  const { slug, inputs } = content;
  if (
    typeof slug !== "string" ||
    typeof inputs !== "object" ||
    inputs === null ||
    Array.isArray(inputs)
  ) {
    throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  }
  return { slug, inputs: inputs as Record<string, unknown> };
}

function assertSupportedExpression(expression: CompiledExpression, state: string): void {
  for (const reference of expression.references) {
    const [root] = reference.split(".");
    if (!SUPPORTED_ROOTS.has(root ?? "")) {
      throw new RoutineExecutionRefusal("unsupported_context", state);
    }
  }
}

function assertSupportedState(state: CompiledState): void {
  if (!SUPPORTED_TYPES.has(state.type)) {
    throw new RoutineExecutionRefusal("unsupported_state", state.name);
  }
  for (const condition of state.conditions) {
    assertSupportedExpression(condition.condition, state.name);
  }
  if (state.iterator !== null) assertSupportedExpression(state.iterator, state.name);
  // An `event` wait is resolved by a signal nothing in this process delivers; parking it is the
  // only honest answer, because opening it would strand the Run on a wait with no signaller.
  if (state.type === "wait" && !isTimerWait(state)) {
    throw new RoutineExecutionRefusal("unsupported_wait", state.name);
  }
}

function assertSupportedInput(state: CompiledState): void {
  for (const mapping of state.inputs) {
    if (mapping.expression !== null) assertSupportedExpression(mapping.expression, state.name);
  }
}

function progressionFrom(status: PersistedState["status"]): readonly StateStatus[] | null {
  // `waiting` re-enters the same claim path: `waiting → ready → claimed → running`.
  if (status === "pending" || status === "waiting") return CLAIM_PATH;
  const index = CLAIM_PATH.indexOf(status as StateStatus);
  return index >= 0 ? CLAIM_PATH.slice(index + 1) : null;
}

function isRefusal(error: unknown): error is RoutineExecutionRefusal | RoutineStepError {
  return error instanceof RoutineExecutionRefusal || error instanceof RoutineStepError;
}

/**
 * Worker-owned executor for the deterministic Routine capabilities: `branch` graphs, durable
 * `wait` timers, and the bounded fan-out and loop constructs (`parallel`, `foreach`,
 * `repeat_until`).
 *
 * Two rules make it replay-safe. Every successor is persisted **before** its predecessor succeeds,
 * so a crash between the two writes replays the same decision into `ensureState` and finds the row
 * it already made. And a fan-out unit is addressed by a durable occurrence key derived from the
 * pinned collection — never from a counter this process holds — so re-executing an attempt walks
 * the same rows instead of scheduling a second copy of settled work.
 *
 * Every other State type is claimed and parked as `needs_reconciliation`: an effect this executor
 * cannot dispatch is never interpreted as a success, and never routed through a second authority.
 */
export function createRoutineExecutor(options: RoutineExecutorOptions): RunExecutor {
  const now = options.now ?? (() => new Date());
  const ceiling = options.identityCeiling ?? defaultIdentityCeiling;

  return async (run) => {
    const loaded = await options.definitions.load(run);
    const routine = compileRoutine(loaded.document, { identityCeiling: ceiling(run) });
    const persisted = new Map(
      (await options.runs.listStates(run.businessId, run.id)).map((state) => [state.key, state])
    );
    const start = persisted.get(routine.start);
    if (start === undefined) return "needs_reconciliation";

    const requestArtifact = await options.artifacts.read({
      businessId: run.businessId,
      artifactId: artifactId(start.resolvedInput.payloadRef, start.key),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: now(),
    });
    if (requestArtifact.schemaRef !== MANUAL_REQUEST_SCHEMA_REF) {
      return "needs_reconciliation";
    }
    const request = manualRequest(requestArtifact.content, start.key);
    if (request.slug !== routine.slug) return "needs_reconciliation";

    const execution = new RoutineExecution({
      run,
      routine,
      request,
      persisted,
      options,
      now,
    });
    // `waiting` parks the Run holding no lease; the deadline sweep requeues it when its timer
    // fires, and this executor replays the chain from the top against the durable rows.
    return execution.runChain(routine.start, "", {}, {}, 0);
  };
}

interface ExecutionContext {
  readonly run: PersistedRun;
  readonly routine: CompiledRoutine;
  readonly request: ManualRoutineRequest;
  readonly persisted: Map<string, PersistedState>;
  readonly options: RoutineExecutorOptions;
  readonly now: () => Date;
}

/** One attempt at one Routine Run. Holds no state a replay could not rebuild from the database. */
class RoutineExecution {
  constructor(private readonly ctx: ExecutionContext) {}

  /**
   * Walk one chain of States to its end.
   *
   * `prefix` addresses the chain's durable rows: empty for the Run's main line, and the fan-out
   * occurrence prefix inside a unit. `extras` carries the roots only a unit has — `item` for a
   * `foreach` body, `loop` for a `repeat_until` body.
   */
  async runChain(
    startName: string,
    prefix: string,
    extras: Readonly<Record<string, unknown>>,
    outputs: StateOutputs,
    depth: number
  ): Promise<ChainOutcome> {
    if (depth > this.ctx.routine.order.length) return "needs_reconciliation";
    let currentName = startName;

    for (let step = 0; step <= this.ctx.routine.order.length; step += 1) {
      const state = this.ctx.routine.states.get(currentName);
      const key = `${prefix}${currentName}`;
      const row = this.ctx.persisted.get(key);
      if (state === undefined || row === undefined) return "needs_reconciliation";

      if (row.status === "failed") return "failed";
      if (row.status === "cancelled" || row.status === "cancelling") return "cancelled";
      if (row.status === "needs_reconciliation" || row.status === "skipped") {
        return "needs_reconciliation";
      }

      const scope = { input: this.ctx.request.inputs, states: outputs, ...extras };
      let outcome: StepOutcome;

      try {
        if (row.status === "succeeded") {
          assertSupportedState(state);
          outcome = this.replayOutcome(state, scope);
        } else {
          const settled = await this.executeState(state, key, row, scope, outputs, depth);
          if (settled.kind !== "outcome") return settled.kind;
          outcome = settled.outcome;
        }
      } catch (error) {
        if (!isRefusal(error) && !(error instanceof RoutineInputResolutionError)) throw error;
        // A settled State cannot be parked; every other path claimed the State before it could
        // refuse, so the reason is recorded on the State an operator will be looking at.
        if (row.status === "succeeded") return "needs_reconciliation";
        await this.park(key, `routine:${error.code}`);
        return "needs_reconciliation";
      }

      outputs[state.name] = { output: null };
      if (outcome.kind === "end") return "succeeded";
      currentName = outcome.target;
    }

    return "needs_reconciliation";
  }

  /**
   * Recompute a settled State's successor. The decision is a pure function of the Context, so a
   * replay of an already-succeeded State can only reach the successor its first execution chose.
   */
  private replayOutcome(
    state: CompiledState,
    scope: Readonly<Record<string, unknown>>
  ): StepOutcome {
    const outcome =
      state.type === "branch" ? decideBranch(state, scope).outcome : stateOutcome(state);
    if (outcome.kind === "transition" && !this.ctx.routine.states.has(outcome.target)) {
      throw new RoutineExecutionRefusal("missing_state", state.name);
    }
    return outcome;
  }

  /** Claim an unsettled State and run it to its own conclusion. */
  private async executeState(
    state: CompiledState,
    key: string,
    row: PersistedState,
    scope: Readonly<Record<string, unknown>>,
    outputs: StateOutputs,
    depth: number
  ): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
    let outcome: StepOutcome | ChainOutcome | null;

    // A `waiting` State is resolved by its wait, not by re-running it.
    if (row.status === "waiting") {
      const resumed = await this.resumeWait(state, key, row);
      if (resumed.kind !== "outcome") return { kind: resumed.kind };
      outcome = resumed.outcome;
    } else {
      const progression = progressionFrom(row.status);
      if (progression === null) return { kind: "needs_reconciliation" };
      await this.claim(key, row.status as StateStatus, progression);
      assertSupportedState(state);

      if (state.type === "wait") return this.openWait(state, key);

      outcome =
        state.type === "branch"
          ? decideBranch(state, scope).outcome
          : await this.runComposite(state, key, scope, outputs, depth);
    }
    if (outcome === null) return { kind: "waiting" };
    if (outcome === "failed") {
      await this.transition(key, "running", "failed", `routine:${state.name}`);
      return { kind: "failed" };
    }
    if (typeof outcome !== "object") return { kind: outcome };

    if (outcome.kind === "transition") {
      await this.scheduleSuccessor(
        state,
        outcome.target,
        prefixOf(key, state.name),
        scope,
        outputs
      );
    }
    await this.transition(key, "running", "succeeded");
    return { kind: "outcome", outcome };
  }

  /**
   * Fan-out and loop States. Units execute in the authored order, in batches no larger than the
   * authored concurrency bound, and each unit is replayed rather than tracked in memory — the
   * durable rows under its occurrence key are the only record of what has settled.
   */
  private async runComposite(
    state: CompiledState,
    key: string,
    scope: Readonly<Record<string, unknown>>,
    outputs: StateOutputs,
    depth: number
  ): Promise<StepOutcome | ChainOutcome | null> {
    if (state.type === "parallel") return this.runParallel(state, key, outputs, depth);
    if (state.type === "foreach") return this.runForeach(state, key, scope, outputs, depth);
    if (state.type === "repeat_until") return this.runRepeat(state, key, scope, outputs, depth);
    throw new RoutineExecutionRefusal("unsupported_state", state.name);
  }

  private async runParallel(
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
        const settled = await this.runUnit(branch, key, branch, {}, outputs, depth);
        if (settled === "cancelled" || settled === "needs_reconciliation") return settled;
        progress = settleParallelBranch(progress, branch, unitStatus(settled));
      }
    }

    return this.join(joinParallel(state, progress), state);
  }

  private async runForeach(
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
        const settled = await this.runUnit(
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

    return this.join(joinForeach(state, progress), state);
  }

  /**
   * A bounded loop. The iteration count is recovered by replaying the durable bodies rather than
   * held in memory, and the elapsed-duration bound is measured from the State's own `startedAt`,
   * so a worker that died mid-loop resumes against the same bounds the first attempt was under.
   */
  private async runRepeat(
    state: CompiledState,
    key: string,
    scope: Readonly<Record<string, unknown>>,
    outputs: StateOutputs,
    depth: number
  ): Promise<StepOutcome | ChainOutcome | null> {
    const row = this.ctx.persisted.get(key);
    const startedAtMs = Date.parse(row?.startedAt ?? this.ctx.now().toISOString());
    let iterations = 0;

    for (;;) {
      const loopScope = { ...scope, loop: { iteration: iterations } };
      const decision = stepRepeat(
        state,
        { iterations, startedAtMs },
        loopScope,
        this.ctx.now().getTime()
      );
      if (decision.kind === "exit") return decision.outcome;

      const settled = await this.runUnit(
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

  /** Schedule a unit's first State under its occurrence key, then walk that unit's chain. */
  private async runUnit(
    bodyName: string,
    parentKey: string,
    unit: string,
    extras: Readonly<Record<string, unknown>>,
    outputs: StateOutputs,
    depth: number
  ): Promise<ChainOutcome> {
    const body = this.ctx.routine.states.get(bodyName);
    if (body === undefined) throw new RoutineExecutionRefusal("missing_state", bodyName);
    const prefix = routineOccurrenceKey(parentKey, unit, "");
    const unitScope = { input: this.ctx.request.inputs, states: { ...outputs }, ...extras };

    assertSupportedInput(body);
    const scheduled = await this.ctx.options.scheduler.schedule({
      run: this.ctx.run,
      stateKey: `${prefix}${body.name}`,
      definitionStateKey: body.name,
      resolvedInput: resolveRoutineStateInput(body, unitScope),
      createdAt: this.ctx.now().toISOString(),
    });
    this.ctx.persisted.set(`${prefix}${body.name}`, scheduled.state);

    return this.runChain(bodyName, prefix, extras, { ...outputs }, depth + 1);
  }

  /**
   * Resolve a settled fan-out.
   *
   * A satisfied join that still names units to cancel is refused: this executor can settle a unit
   * but cannot cancel one that is parked on a live timer, and proceeding past it would leave a
   * wait whose resume has nowhere to go.
   */
  private join(
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

  /** Open a durable timer and park the State on it. */
  private async openWait(
    state: CompiledState,
    key: string
  ): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
    const waitId = routineWaitId(this.ctx.run.id, key);
    // A worker that died between creating the wait and parking the State finds its own wait here.
    const existing = await this.ctx.options.waits.find(this.ctx.run.businessId, waitId);
    if (existing === null) {
      await this.ctx.options.waits.register(
        planTimerWait(state, {
          businessId: this.ctx.run.businessId,
          runId: this.ctx.run.id,
          waitId,
          stateKey: key,
          now: this.ctx.now().toISOString(),
        })
      );
    }
    await this.transition(key, "running", "waiting");
    return { kind: "waiting" };
  }

  /**
   * Continue a State whose timer has resolved; a timer that expired takes its authored path.
   *
   * A resolved State is left `running` and its continuation handed back, so the caller settles it
   * on the one path that persists the successor first — a resumed wait is scheduled exactly like
   * any other State's successor.
   */
  private async resumeWait(
    state: CompiledState,
    key: string,
    row: PersistedState
  ): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
    const wait = await this.ctx.options.waits.find(
      this.ctx.run.businessId,
      routineWaitId(this.ctx.run.id, key)
    );
    if (wait === null) return { kind: "needs_reconciliation" };
    if (wait.status === "pending") return { kind: "waiting" };

    await this.claim(key, row.status as StateStatus, CLAIM_PATH);
    if (wait.status === "satisfied") return { kind: "outcome", outcome: stateOutcome(state) };

    const decision = resolveErrorPath(state, WAIT_TIMED_OUT, "attention");
    if (decision.kind === "handled") return { kind: "outcome", outcome: decision.outcome };
    if (decision.kind === "failed") {
      await this.transition(key, "running", "failed", `routine:${WAIT_TIMED_OUT}`);
      return { kind: "failed" };
    }
    await this.park(key, `routine:${WAIT_TIMED_OUT}`);
    return { kind: "needs_reconciliation" };
  }

  /** Persist the successor before its predecessor succeeds. */
  private async scheduleSuccessor(
    state: CompiledState,
    target: string,
    prefix: string,
    scope: Readonly<Record<string, unknown>>,
    outputs: StateOutputs
  ): Promise<void> {
    const next = this.ctx.routine.states.get(target);
    if (next === undefined) throw new RoutineExecutionRefusal("missing_state", state.name);
    assertSupportedInput(next);
    const targetScope = { ...scope, states: { ...outputs, [state.name]: { output: null } } };
    const scheduled = await this.ctx.options.scheduler.schedule({
      run: this.ctx.run,
      stateKey: `${prefix}${next.name}`,
      definitionStateKey: next.name,
      resolvedInput: resolveRoutineStateInput(next, targetScope),
      createdAt: this.ctx.now().toISOString(),
    });
    this.ctx.persisted.set(`${prefix}${next.name}`, scheduled.state);
  }

  private async claim(
    key: string,
    from: StateStatus,
    progression: readonly StateStatus[]
  ): Promise<void> {
    let current = from;
    for (const to of progression) {
      await this.transition(key, current, to);
      current = to;
    }
  }

  private async park(key: string, reason: string): Promise<void> {
    await this.transition(key, "running", "needs_reconciliation", reason);
  }

  private async transition(
    key: string,
    from: StateStatus,
    to: StateStatus,
    reason?: string
  ): Promise<void> {
    await this.ctx.options.transitions.transition({
      businessId: this.ctx.run.businessId,
      runId: this.ctx.run.id,
      stateKey: key,
      from,
      to,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

/** The chain prefix a State's own successors are addressed under. */
function prefixOf(key: string, stateName: string): string {
  return key.slice(0, key.length - stateName.length);
}

/** A unit parked on a wait is still running, not settled — its join stays pending. */
function unitStatus(outcome: ChainOutcome): "succeeded" | "failed" | "running" {
  if (outcome === "succeeded") return "succeeded";
  if (outcome === "failed") return "failed";
  return "running";
}
