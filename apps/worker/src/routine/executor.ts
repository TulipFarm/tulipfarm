import type { AuthorityLayer } from "@tulipfarm/authz";
import {
  type ArtifactService,
  agentOutputSchema,
  type CompiledExpression,
  type CompiledRoutine,
  type CompiledState,
  compileRoutine,
  decideBranch,
  type ForeachProgress,
  type IdentityCeiling,
  InMemoryStateRetryStore,
  initForeachProgress,
  initParallelProgress,
  isTimerWait,
  joinForeach,
  joinParallel,
  type ParallelProgress,
  type PersistedWait,
  planAgentInvocation,
  planApprovalWait,
  planForeach,
  planParallel,
  planTimerWait,
  planToolDispatch,
  type RegisterWaitInput,
  RoutineInputResolutionError,
  type RoutineStateScheduler,
  RoutineStepError,
  RUN_EXECUTOR_PRINCIPAL_REF,
  resolveApproval,
  resolveErrorPath,
  resolveForeachItems,
  resolveRoutineStateInput,
  retryBackoffMs,
  routineOccurrenceKey,
  routineWaitId,
  type StateRetryStore,
  type StateStatus,
  type StepOutcome,
  settleForeachItem,
  settleParallelBranch,
  stateOutcome,
  stepRepeat,
} from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { PersistedRun, PersistedState, RunStore } from "@tulipfarm/storage";
import type { StateTransitionPort } from "../agent-state";
import type { RunExecutor } from "../executors";
import type { RoutineAgentPort } from "./agent-port";
import type { RoutineApprovalPort } from "./approval-port";
import type { WorkerRoutineDefinitionLoader } from "./definition-loader";
import type { RoutineToolPort } from "./tool-port";

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

/** Durable-wait surface; the executor never redeems resume tokens. */
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
  /** Absent means `tool` States park; there is no second external-effect path. */
  readonly tools?: RoutineToolPort;
  /** Absent means `agent` States park; the executor will not invent answers. */
  readonly agents?: RoutineAgentPort;
  /** Absent means `approval` States park; Runs cannot pass unasked questions. */
  readonly approvals?: RoutineApprovalPort;
  /** Fail-closed authority; this process may not mint authority of its own. */
  readonly authority?: (run: PersistedRun, state: CompiledState) => readonly AuthorityLayer[];
  /**
   * Durable per-State-occurrence retry counter. A State's authored `retry` policy is only honoured
   * when this is present and durable; without it a park-and-resume would refund the budget. The
   * executor defaults to a non-durable in-memory store so tests and unconfigured hosts still run.
   */
  readonly retries?: StateRetryStore;
  /** Backoff sleep between retry attempts; injectable so tests do not wait real time. */
  readonly delay?: (ms: number) => Promise<void>;
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
  "agent",
  "approval",
  "branch",
  "tool",
  "wait",
  "parallel",
  "foreach",
  "repeat_until",
]);

/** Error reference an expired `wait` raises, so an authored `onError` handler can claim it. */
const WAIT_TIMED_OUT = "wait_timed_out";

/** Prefix an authored `onError` handler claims a refused or failed Tool dispatch by. */
const TOOL_ERROR_PREFIX = "tool_";

/** Prefix an authored `onError` handler claims a refused or failed Agent answer by. */
const AGENT_ERROR_PREFIX = "agent_";

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

type ClassifiableOutcome = { readonly kind: string; readonly retryable?: boolean };

/**
 * A failure a State's `retry` policy may re-attempt: only one a port explicitly marked
 * `retryable`. Absence of the flag (every `tool` failure, by the effect ledger's design) is
 * terminal, so an unmarked failure is never retried.
 */
function isRetryableFailure(outcome: ClassifiableOutcome): boolean {
  return outcome.kind === "failed" && outcome.retryable === true;
}

/** Executes deterministic Routine States; persists successors before predecessor success. */
export function createRoutineExecutor(options: RoutineExecutorOptions): RunExecutor {
  const now = options.now ?? (() => new Date());
  const ceiling = options.identityCeiling ?? defaultIdentityCeiling;
  const retries = options.retries ?? new InMemoryStateRetryStore();
  const delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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
      bundle: loaded.bundle,
      request,
      persisted,
      options,
      retries,
      delay,
      now,
    });
    // `waiting` holds no lease; replay starts from durable rows after the sweep requeues it.
    return execution.runChain(routine.start, "", {}, {}, 0);
  };
}

interface ExecutionContext {
  readonly run: PersistedRun;
  readonly routine: CompiledRoutine;
  /** The Run's exact pinned bundle — the only source of Tool contracts and Guardrail policy. */
  readonly bundle: RuntimeBundle;
  readonly request: ManualRoutineRequest;
  readonly persisted: Map<string, PersistedState>;
  readonly options: RoutineExecutorOptions;
  readonly retries: StateRetryStore;
  readonly delay: (ms: number) => Promise<void>;
  readonly now: () => Date;
}

/** One attempt at one Routine Run. Holds no state a replay could not rebuild from the database. */
class RoutineExecution {
  constructor(private readonly ctx: ExecutionContext) {}

  /** Walks one chain; `prefix` addresses durable fan-out rows and `extras` adds unit roots. */
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
        // Settled States cannot be parked; claimed States record the refusal on their own row.
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

  /** Recomputes a settled State's pure successor for replay. */
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
      const resumed =
        state.type === "approval"
          ? await this.resumeApproval(state, key, row)
          : await this.resumeWait(state, key, row);
      if (resumed.kind !== "outcome") return { kind: resumed.kind };
      outcome = resumed.outcome;
    } else {
      const progression = progressionFrom(row.status);
      if (progression === null) return { kind: "needs_reconciliation" };
      await this.claim(key, row.status as StateStatus, progression);
      assertSupportedState(state);

      if (state.type === "wait") return this.openWait(state, key);
      if (state.type === "approval") return this.openApproval(state, key);

      outcome =
        state.type === "branch"
          ? decideBranch(state, scope).outcome
          : state.type === "tool"
            ? await this.runTool(state, key, scope)
            : state.type === "agent"
              ? await this.runAgent(state, key, row, scope)
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

  /** Tool States use the Broker; only confirmed effects succeed, ambiguous cases park. */
  private async runTool(
    state: CompiledState,
    key: string,
    scope: Readonly<Record<string, unknown>>
  ): Promise<StepOutcome | ChainOutcome | null> {
    const port = this.ctx.options.tools;
    if (port === undefined) throw new RoutineExecutionRefusal("unsupported_state", state.name);

    const result = await this.withRetry(state, key, () =>
      port.execute({
        businessId: this.ctx.run.businessId,
        runId: this.ctx.run.id,
        stateKey: key,
        plan: planToolDispatch(state, scope, {
          businessId: this.ctx.run.businessId,
          runId: this.ctx.run.id,
          stateKey: key,
        }),
        bundle: this.ctx.bundle,
        authorityLayers: this.ctx.options.authority?.(this.ctx.run, state) ?? [],
      })
    );

    if (result.kind === "succeeded") return stateOutcome(state);
    if (result.kind !== "failed") {
      await this.park(key, `routine:${result.reason}`);
      return "needs_reconciliation";
    }

    const decision = resolveErrorPath(state, `${TOOL_ERROR_PREFIX}${result.reason}`, "failed");
    if (decision.kind === "handled") return decision.outcome;
    if (decision.kind === "failed") return "failed";
    await this.park(key, `routine:${TOOL_ERROR_PREFIX}${result.reason}`);
    return "needs_reconciliation";
  }

  /** Agent States use the pinned bundle; failures take `agent_<reason>`, unknowns park. */
  private async runAgent(
    state: CompiledState,
    key: string,
    row: PersistedState,
    scope: Readonly<Record<string, unknown>>
  ): Promise<StepOutcome | ChainOutcome | null> {
    const port = this.ctx.options.agents;
    if (port === undefined) throw new RoutineExecutionRefusal("unsupported_state", state.name);

    const plan = planAgentInvocation(state, scope);
    const schema = agentOutputSchema(this.ctx.routine.outputSchemas, plan.outputSchemaRef);
    const result = await this.withRetry(state, key, (attemptNumber) =>
      port.execute({
        businessId: this.ctx.run.businessId,
        runId: this.ctx.run.id,
        stateKey: key,
        // Claimed row version plus the retry attempt keep each attempt's loop events distinct.
        attempt: row.version + (attemptNumber - 1),
        plan,
        ...(schema === undefined ? {} : { outputSchema: schema }),
        bundle: this.ctx.bundle,
      })
    );

    if (result.kind === "succeeded") return stateOutcome(state);
    if (result.kind === "cancelled") return "cancelled";
    if (result.kind !== "failed") {
      await this.park(key, `routine:${result.reason}`);
      return "needs_reconciliation";
    }

    const decision = resolveErrorPath(state, `${AGENT_ERROR_PREFIX}${result.reason}`, "failed");
    if (decision.kind === "handled") return decision.outcome;
    if (decision.kind === "failed") return "failed";
    await this.park(key, `routine:${AGENT_ERROR_PREFIX}${result.reason}`);
    return "needs_reconciliation";
  }

  /** Fan-out/loop units replay from durable occurrence-key rows, not memory. */
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

  /** Bounded loops recover iteration count from rows and elapsed time from State `startedAt`. */
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

  /** Refuses joins that require cancelling live-timer units this executor cannot cancel. */
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

  /** Opens API-side approval wait; Worker never sees the resume token. */
  private async openApproval(
    state: CompiledState,
    key: string
  ): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
    const port = this.ctx.options.approvals;
    if (port === undefined) throw new RoutineExecutionRefusal("unsupported_state", state.name);

    await port.open({
      businessId: this.ctx.run.businessId,
      runId: this.ctx.run.id,
      stateKey: key,
      stateName: state.name,
      wait: planApprovalWait(state, {
        businessId: this.ctx.run.businessId,
        runId: this.ctx.run.id,
        // Derived from `(runId, occurrence key)` so replay finds the same approval.
        waitId: routineWaitId(this.ctx.run.id, key),
        stateKey: key,
        now: this.ctx.now().toISOString(),
      }),
    });
    await this.transition(key, "running", "waiting");
    return { kind: "waiting" };
  }

  /** Rejections take `approval_rejected`; expiries park instead of becoming yes/no. */
  private async resumeApproval(
    state: CompiledState,
    key: string,
    row: PersistedState
  ): Promise<{ kind: "outcome"; outcome: StepOutcome } | { kind: ChainOutcome }> {
    const port = this.ctx.options.approvals;
    if (port === undefined) return { kind: "needs_reconciliation" };

    const record = await port.find({
      businessId: this.ctx.run.businessId,
      runId: this.ctx.run.id,
      stateKey: key,
    });
    // Missing approval for a parked State is reconciliation-only.
    if (record === undefined) return { kind: "needs_reconciliation" };
    if (record.decision === "pending") return { kind: "waiting" };

    await this.claim(key, row.status as StateStatus, CLAIM_PATH);
    const decision = resolveApproval(
      state,
      record.decision === "approved"
        ? "approved"
        : record.decision === "denied"
          ? "rejected"
          : "expired"
    );
    if (decision.kind === "continue" || decision.kind === "handled") {
      return { kind: "outcome", outcome: decision.outcome };
    }
    if (decision.kind === "failed") {
      await this.transition(key, "running", "failed", `routine:${decision.errorRef}`);
      return { kind: "failed" };
    }
    await this.park(key, `routine:${decision.errorRef}`);
    return { kind: "needs_reconciliation" };
  }

  /** Resumed timers stay `running` until the caller persists the successor first. */
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

  /**
   * Runs one State effect under its authored `retry` policy.
   *
   * A failure the effect's port marked `retryable` (a transient provider fault) is re-attempted
   * until the durable attempt count reaches `maxAttempts`; a success, a terminal failure, or a park
   * returns at once. The count is loaded from and written to the durable store before every
   * attempt, so a park-and-resume or a crash-and-reclaim continues from the attempts already spent
   * rather than restarting the budget — the same durability the Run's budget ledger gives. A State
   * with no `retry` policy makes exactly one attempt and never touches the store.
   *
   * A crash between recording the final attempt and settling the State can cost one extra attempt
   * on reclaim; the guarantee is that the budget is never *refunded*, never that it is never
   * exceeded by one.
   */
  private async withRetry<T extends { readonly kind: string }>(
    state: CompiledState,
    key: string,
    attempt: (attemptNumber: number) => Promise<T>
  ): Promise<T> {
    const policy = state.retry;
    if (policy === null) return attempt(1);

    const loaded = await this.ctx.retries.load(this.ctx.run.businessId, this.ctx.run.id, key);
    let made = loaded?.attempts ?? 0;
    for (;;) {
      made += 1;
      // Persist before the attempt so a crash mid-attempt cannot refund the budget it spends.
      await this.ctx.retries.record({
        businessId: this.ctx.run.businessId,
        runId: this.ctx.run.id,
        stateKey: key,
        attempts: made,
      });
      const outcome = await attempt(made);
      if (made >= policy.maxAttempts || !isRetryableFailure(outcome)) return outcome;
      const backoffMs = retryBackoffMs(policy, made);
      if (backoffMs > 0) await this.ctx.delay(backoffMs);
    }
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
