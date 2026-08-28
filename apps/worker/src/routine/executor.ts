import type { AuthorityLayer } from "@tulipfarm/authz";
import {
  type ArtifactService,
  agentOutputSchema,
  type CompiledRoutine,
  type CompiledState,
  compileRoutine,
  computeStateOutput,
  decideBranch,
  type IdentityCeiling,
  InMemoryStateConcurrencyStore,
  InMemoryStateContentionStore,
  InMemoryStateRetryStore,
  planActionDispatch,
  planAgentInvocation,
  planEmit,
  planScriptExecution,
  planToolDispatch,
  RoutineInputResolutionError,
  type RoutineStateScheduler,
  RUN_EXECUTOR_PRINCIPAL_REF,
  resolveErrorPath,
  resolveRoutineStateInput,
  retryBackoffMs,
  routineBudgetScopedLimits,
  routineOccurrenceKey,
  type StateConcurrencyStore,
  type StateContentionStore,
  type StateRetryStore,
  type StateStatus,
  type StepOutcome,
  stateOutcome,
} from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { PersistedRun, PersistedState, RunStore } from "@tulipfarm/storage";
import type { StateTransitionPort } from "@tulipfarm/turn-executor";
import type { RunExecutor } from "../executors";
import type { RoutineActionPort } from "./action-port";
import type { RoutineAgentPort } from "./agent-port";
import type { RoutineApprovalPort } from "./approval-port";
import type { ChildRoutinePort } from "./child-routine-port";
import {
  type ConcurrencyGuardContext,
  concurrencyBackoffElapsed,
  underConcurrencyKey,
} from "./concurrency-guard";
import type { WorkerRoutineDefinitionLoader } from "./definition-loader";
import type { EmitPort } from "./emit-port";
import {
  ACTION_ERROR_PREFIX,
  AGENT_ERROR_PREFIX,
  artifactId,
  assertSupportedInput,
  assertSupportedState,
  type ChainOutcome,
  isRefusal,
  isRetryableFailure,
  type ManualRoutineRequest,
  manualRequest,
  progressionFrom,
  RoutineExecutionRefusal,
  SCRIPT_ERROR_PREFIX,
  type StateOutputs,
  TOOL_ERROR_PREFIX,
} from "./execution-support";
import { type FanOutContext, runComposite } from "./fan-out";
import type { RoutineScriptPort } from "./script-port";
import type { RoutineToolPort } from "./tool-port";
import {
  openApproval,
  openChildRoutine,
  openWait,
  type RoutineWaitPort,
  resumeApproval,
  resumeChildRoutine,
  resumeWait,
  type WaitGateContext,
} from "./wait-gate";

interface RoutineArtifactReader {
  read: ArtifactService["read"];
}

interface RoutineRunStateReader {
  listStates: Pick<RunStore, "listStates">["listStates"];
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
  /** Runs a `script` State's authored TypeScript; absent refuses the State by name. */
  readonly scripts?: RoutineScriptPort;
  /** Runs an `action` State's runtime Tool; absent refuses the State by name. */
  readonly actions?: RoutineActionPort;
  /** Absent means `agent` States park; the executor will not invent answers. */
  readonly agents?: RoutineAgentPort;
  /** Absent means `approval` States park; Runs cannot pass unasked questions. */
  readonly approvals?: RoutineApprovalPort;
  /** Absent means `child_routine` States park; a Routine cannot skip a call it authored. */
  readonly childRoutines?: ChildRoutinePort;
  readonly emissions?: EmitPort;
  /** Fail-closed authority; this process may not mint authority of its own. */
  readonly authority?: (run: PersistedRun, state: CompiledState) => readonly AuthorityLayer[];
  /**
   * Durable per-State-occurrence retry counter. A State's authored `retry` policy is only honoured
   * when this is present and durable; without it a park-and-resume would refund the budget. The
   * executor defaults to a non-durable in-memory store so tests and unconfigured hosts still run.
   */
  readonly retries?: StateRetryStore;
  /**
   * Durable mutual exclusion for a State's authored `concurrencyKey`. Contenders live in other
   * worker processes, so only a durable store actually serializes them; the executor defaults to a
   * non-durable in-memory store so tests and unconfigured hosts still run.
   */
  readonly concurrency?: StateConcurrencyStore;
  /**
   * Durable count of the backoff waits a contended State occurrence has already spent. Without a
   * durable store every resume would hand the contender a fresh ceiling, so a busy key could be
   * queued for forever instead of the bounded window; the executor defaults to a non-durable
   * in-memory store so tests and unconfigured hosts still run.
   */
  readonly contention?: StateContentionStore;
  /** Backoff sleep between retry attempts; injectable so tests do not wait real time. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly identityCeiling?: (run: PersistedRun) => IdentityCeiling;
}

/**
 * What a Routine may do when its author narrowed nothing.
 *
 * `permissionCeiling` is an opt-in narrowing: a State declares it to run with *less* than the
 * Run's owner holds, and the compiler refuses one that escalates. Inventing a ceiling here where
 * the author declared none inverts that — it becomes a cap no Routine can lift, because the
 * compiler measures an authored ceiling against this very value. Capping at `low` denied every
 * mutating Tool, so `record_create` — the whole point of a deterministic Routine — could never
 * run. The widest class is therefore the honest default: authority is still bounded by the Run
 * subject's own grants, which is the layer that is meant to bound it.
 */
function defaultIdentityCeiling(run: PersistedRun): IdentityCeiling {
  return {
    principalKind: run.identity.effectiveSubject.kind,
    principalId: run.identity.effectiveSubject.id,
    grants: [],
    maxRiskClass: "high",
  };
}

/**
 * The value a settled State publishes to `states.<name>.output`.
 *
 * Only `compute` publishes one today: it is derived from the scope, so it can be recomputed
 * identically on every read and never has to be persisted. Every other State type reports `null`
 * rather than a value this process cannot rebuild, because a State whose output silently became
 * `null` after a resume would be worse than one that never had an output at all.
 */
/**
 * A `compute` State re-derives its value from scope on replay, so it is never stored. Every other
 * State publishes something a replay cannot reproduce — a model answer, a provider response, an
 * isolate's return value — and reads it back from `run_states.output` instead.
 */
function recomputes(state: CompiledState): boolean {
  return state.type === "compute";
}

/** A State output is stored on the Run row, so an unbounded provider response cannot land whole. */
const MAX_OUTPUT_BYTES = 128 * 1024;

/**
 * Keeps a State output storable. An oversized value is replaced rather than truncated, because a
 * half-serialized object would read back as valid JSON and quietly lie to the State downstream.
 */
export function boundedOutput(value: unknown): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value ?? null) ?? "null";
  } catch {
    return { truncated: true, reason: "unserializable" };
  }
  if (Buffer.byteLength(encoded, "utf8") <= MAX_OUTPUT_BYTES) return value ?? null;
  return { truncated: true, reason: "too_large", bytes: Buffer.byteLength(encoded, "utf8") };
}

/** Executes deterministic Routine States; persists successors before predecessor success. */
export function createRoutineExecutor(options: RoutineExecutorOptions): RunExecutor {
  const now = options.now ?? (() => new Date());
  const ceiling = options.identityCeiling ?? defaultIdentityCeiling;
  const retries = options.retries ?? new InMemoryStateRetryStore();
  const concurrency = options.concurrency ?? new InMemoryStateConcurrencyStore();
  const contention = options.contention ?? new InMemoryStateContentionStore();
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
      concurrency,
      contention,
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
  readonly concurrency: StateConcurrencyStore;
  readonly contention: StateContentionStore;
  readonly delay: (ms: number) => Promise<void>;
  readonly now: () => Date;
}

/** One attempt at one Routine Run. Holds no state a replay could not rebuild from the database. */
class RoutineExecution {
  /** What a State produced in *this* pass, before its row has been read back. */
  private readonly produced = new Map<string, unknown>();

  /**
   * Why a State is about to fail, keyed by State occurrence.
   *
   * A refusing port answers with a reason code, but the failure travels back to the caller as the
   * bare string `"failed"`, which would leave `error_evidence_ref` holding only the State's name.
   * That is a label, not evidence: it says which step broke and nothing about what broke it, so a
   * failed Run cannot be diagnosed from its own record. Stashing the reason here lets the
   * transition write it.
   */
  private readonly failureReasons = new Map<string, string>();

  constructor(private readonly ctx: ExecutionContext) {}

  /**
   * What `states.<name>.output` resolves to: recomputed for a pure State, otherwise the value this
   * pass produced, otherwise the one stored when the State first ran.
   */
  private outputFor(
    state: CompiledState,
    key: string,
    scope: Readonly<Record<string, unknown>>
  ): unknown {
    if (recomputes(state)) return computeStateOutput(state, scope);
    if (this.produced.has(key)) return this.produced.get(key) ?? null;
    return this.ctx.persisted.get(key)?.output ?? null;
  }

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
      let output: unknown = null;

      try {
        if (row.status === "succeeded") {
          assertSupportedState(state);
          outcome = this.replayOutcome(state, scope);
        } else {
          const settled = await this.executeState(state, key, row, scope, outputs, depth);
          if (settled.kind !== "outcome") return settled.kind;
          outcome = settled.outcome;
        }
        // A pure State is recomputed so a replayed Run publishes what its first attempt did —
        // safe only because the expression language is total and side-effect free, and free of a
        // second failure mode because the fresh path already proved this evaluates before it let
        // the State settle. Everything else reads back the value stored when it ran.
        output = this.outputFor(state, key, scope);
      } catch (error) {
        if (!isRefusal(error) && !(error instanceof RoutineInputResolutionError)) throw error;
        // Settled States cannot be parked; claimed States record the refusal on their own row.
        if (row.status === "succeeded") return "needs_reconciliation";
        await this.park(key, `routine:${error.code}`);
        return "needs_reconciliation";
      }

      outputs[state.name] = { output };
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

    // A `waiting` State is resolved by its wait, not by re-running it — unless the wait it is on
    // is a concurrency backoff, which exists precisely to bring it back *into* execution.
    if (row.status === "waiting" && !(await this.backoffElapsed(state, key))) {
      const resumed =
        state.type === "approval"
          ? await resumeApproval(this.waitGate(), state, key, row)
          : state.type === "child_routine"
            ? await resumeChildRoutine(this.waitGate(), state, key, row)
            : await resumeWait(this.waitGate(), state, key, row);
      if (resumed.kind !== "outcome") return { kind: resumed.kind };
      outcome = resumed.outcome;
    } else {
      const progression = progressionFrom(row.status);
      if (progression === null) return { kind: "needs_reconciliation" };
      await this.claim(key, row.status as StateStatus, progression);
      assertSupportedState(state);

      if (state.type === "wait") return openWait(this.waitGate(), state, key);
      if (state.type === "approval") return openApproval(this.waitGate(), state, key);
      if (state.type === "child_routine") {
        // Unlike `wait` and `approval`, a call can continue in the same pass — detached, or with
        // a child that had already settled — so it falls through to the common tail that
        // schedules the successor and marks the row succeeded.
        const called = await openChildRoutine(this.waitGate(), state, key, scope);
        if (called.kind !== "outcome") return { kind: called.kind };
        outcome = called.outcome;
      } else {
        outcome = await this.underConcurrencyKey(state, key, () =>
          state.type === "branch"
            ? Promise.resolve(decideBranch(state, scope).outcome)
            : state.type === "compute"
              ? Promise.resolve(this.runCompute(state, scope))
              : state.type === "script"
                ? this.runScript(state, key, scope)
                : state.type === "action"
                  ? this.runAction(state, key, scope)
                  : state.type === "tool"
                    ? this.runTool(state, key, scope)
                    : state.type === "emit"
                      ? this.runEmit(state, key, scope)
                      : state.type === "agent"
                        ? this.runAgent(state, key, row, scope)
                        : runComposite(this.fanOut(), state, key, scope, outputs, depth)
        );
      }
    }
    if (outcome === null) return { kind: "waiting" };
    if (outcome === "failed") {
      await this.transition(
        key,
        "running",
        "failed",
        this.failureReasons.get(key) ?? `routine:${state.name}`
      );
      return { kind: "failed" };
    }
    if (typeof outcome !== "object") return { kind: outcome };

    if (outcome.kind === "transition") {
      await this.scheduleSuccessor(state, outcome.target, key, scope, outputs);
    }
    await this.settle(key, state);
    return { kind: "outcome", outcome };
  }

  /**
   * `compute` settles in-process from the scope alone.
   *
   * The value is evaluated and discarded here on purpose: it must be proven to evaluate *before*
   * the State is marked succeeded, or a bad expression would park a row that had already settled.
   * `runChain` recomputes it from the same immutable scope to publish it.
   */
  private runCompute(state: CompiledState, scope: Readonly<Record<string, unknown>>): StepOutcome {
    computeStateOutput(state, scope);
    return stateOutcome(state);
  }
  /**
   * `emit` announces an internal event and continues.
   *
   * Whether the event bound a Trigger does not settle this State: `emit` is fire-and-forget by
   * definition, and an emitter that failed because nothing was listening would couple every
   * Routine to the Triggers other authors happen to have published. Only a refusal to *announce*
   * — an unreachable API, or a chain already at its depth bound — fails it.
   */
  private async runEmit(
    state: CompiledState,
    key: string,
    scope: Readonly<Record<string, unknown>>
  ): Promise<StepOutcome> {
    const port = this.ctx.options.emissions;
    if (port === undefined) throw new RoutineExecutionRefusal("unsupported_state", state.name);

    const planned = planEmit(state, scope);
    await port.emit({
      businessId: this.ctx.run.businessId,
      runId: this.ctx.run.id,
      stateKey: key,
      eventType: planned.eventType,
      eventVersion: planned.eventVersion,
      data: planned.data,
    });
    return stateOutcome(state);
  }

  /** Tool States use the Broker; only confirmed effects succeed, ambiguous cases park. */
  /**
   * `script` States run authored TypeScript in the sealed isolate and publish what it returned.
   *
   * The value is persisted rather than recomputed on replay. The isolate is deterministic, but an
   * author's function is opaque in a way an expression is not, and re-entering it would charge a
   * resumed Run for work it already paid for.
   */
  private async runScript(
    state: CompiledState,
    key: string,
    scope: Readonly<Record<string, unknown>>
  ): Promise<StepOutcome | ChainOutcome | null> {
    const port = this.ctx.options.scripts;
    if (port === undefined) throw new RoutineExecutionRefusal("unsupported_state", state.name);

    const result = await this.withRetry(state, key, () =>
      port.execute({
        runId: this.ctx.run.id,
        stateKey: key,
        plan: planScriptExecution(state, scope),
      })
    );

    if (result.kind === "succeeded") {
      this.produced.set(key, result.output);
      return stateOutcome(state);
    }
    const code = `${SCRIPT_ERROR_PREFIX}${result.reason}`;
    const decision = resolveErrorPath(state, code, "failed");
    if (decision.kind === "handled") return decision.outcome;
    if (decision.kind === "failed") return this.refuse(key, code);
    await this.park(key, `routine:${code}`);
    return "needs_reconciliation";
  }

  /**
   * `action` States call one runtime Tool with no model deciding to, and publish what it returned.
   *
   * This is the path a Routine uses to reach the world deterministically: `api_request`,
   * `record_create`, `send_slack_message`. Authority is the Run's own recorded subject — the
   * dispatch names no Agent — so a Routine can do no more than whoever owns it may do.
   */
  private async runAction(
    state: CompiledState,
    key: string,
    scope: Readonly<Record<string, unknown>>
  ): Promise<StepOutcome | ChainOutcome | null> {
    const port = this.ctx.options.actions;
    if (port === undefined) throw new RoutineExecutionRefusal("unsupported_state", state.name);

    const result = await this.withRetry(state, key, () =>
      port.execute({
        businessId: this.ctx.run.businessId,
        runId: this.ctx.run.id,
        stateKey: key,
        plan: planActionDispatch(state, scope, { runId: this.ctx.run.id, stateKey: key }),
      })
    );

    if (result.kind === "succeeded") {
      this.produced.set(key, result.output);
      return stateOutcome(state);
    }
    if (result.kind !== "failed") {
      await this.park(key, `routine:${result.reason}`);
      return "needs_reconciliation";
    }
    const code = `${ACTION_ERROR_PREFIX}${result.reason}`;
    const decision = resolveErrorPath(state, code, "failed");
    if (decision.kind === "handled") return decision.outcome;
    if (decision.kind === "failed") return this.refuse(key, code);
    await this.park(key, `routine:${code}`);
    return "needs_reconciliation";
  }

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

    if (result.kind === "succeeded") {
      this.produced.set(key, result.output);
      return stateOutcome(state);
    }
    if (result.kind !== "failed") {
      await this.park(key, `routine:${result.reason}`);
      return "needs_reconciliation";
    }

    const code = `${TOOL_ERROR_PREFIX}${result.reason}`;
    const decision = resolveErrorPath(state, code, "failed");
    if (decision.kind === "handled") return decision.outcome;
    if (decision.kind === "failed") return this.refuse(key, code);
    await this.park(key, `routine:${code}`);
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
    // The authored Routine's cost/token ceiling; resolved with the ModelProfile's own budgets by
    // the port, so the ledger it opens carries one ceiling per key rather than two.
    const scopedLimits = routineBudgetScopedLimits(this.ctx.routine);
    const result = await this.withRetry(state, key, (attemptNumber) =>
      port.execute({
        businessId: this.ctx.run.businessId,
        runId: this.ctx.run.id,
        stateKey: key,
        // Claimed row version plus the retry attempt keep each attempt's loop events distinct.
        attempt: row.version + (attemptNumber - 1),
        plan,
        ...(schema === undefined ? {} : { outputSchema: schema }),
        ...(scopedLimits === undefined ? {} : { scopedLimits: [scopedLimits] }),
        bundle: this.ctx.bundle,
      })
    );

    if (result.kind === "succeeded") {
      this.produced.set(key, result.output);
      return stateOutcome(state);
    }
    if (result.kind === "cancelled") return "cancelled";
    if (result.kind !== "failed") {
      await this.park(key, `routine:${result.reason}`);
      return "needs_reconciliation";
    }

    const code = `${AGENT_ERROR_PREFIX}${result.reason}`;
    const decision = resolveErrorPath(state, code, "failed");
    if (decision.kind === "handled") return decision.outcome;
    if (decision.kind === "failed") return this.refuse(key, code);
    await this.park(key, `routine:${code}`);
    return "needs_reconciliation";
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

  /** Serializes a State's authored `concurrencyKey`, queueing a contender rather than parking. */
  private underConcurrencyKey(
    state: CompiledState,
    key: string,
    work: () => Promise<StepOutcome | ChainOutcome | null>
  ): Promise<StepOutcome | ChainOutcome | null> {
    return underConcurrencyKey(this.guard(), state, key, work);
  }

  /** True when a `waiting` row is a fired concurrency backoff, so it resumes into execution. */
  private backoffElapsed(state: CompiledState, key: string): Promise<boolean> {
    return concurrencyBackoffElapsed(this.guard(), state, key);
  }

  private fanOut(): FanOutContext {
    return {
      persisted: this.ctx.persisted,
      now: this.ctx.now,
      runUnit: (bodyName, parentKey, unit, extras, outputs, depth) =>
        this.runUnit(bodyName, parentKey, unit, extras, outputs, depth),
    };
  }

  private waitGate(): WaitGateContext {
    return {
      run: this.ctx.run,
      waits: this.ctx.options.waits,
      ...(this.ctx.options.approvals === undefined
        ? {}
        : { approvals: this.ctx.options.approvals }),
      ...(this.ctx.options.childRoutines === undefined
        ? {}
        : { childRoutines: this.ctx.options.childRoutines }),
      now: this.ctx.now,
      transition: (key, from, to, reason) => this.transition(key, from, to, reason),
      claim: (key, from, progression) => this.claim(key, from, progression),
      park: (key, reason) => this.park(key, reason),
    };
  }

  private guard(): ConcurrencyGuardContext {
    return {
      run: this.ctx.run,
      concurrency: this.ctx.concurrency,
      contention: this.ctx.contention,
      waits: this.ctx.options.waits,
      now: this.ctx.now,
      delay: this.ctx.delay,
      transition: (key, from, to, reason) => this.transition(key, from, to, reason),
    };
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
    key: string,
    scope: Readonly<Record<string, unknown>>,
    outputs: StateOutputs
  ): Promise<void> {
    const prefix = prefixOf(key, state.name);
    const next = this.ctx.routine.states.get(target);
    if (next === undefined) throw new RoutineExecutionRefusal("missing_state", state.name);
    assertSupportedInput(next);
    const targetScope = {
      ...scope,
      states: { ...outputs, [state.name]: { output: this.outputFor(state, key, scope) } },
    };
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

  /** Records why a State is failing so the transition can write evidence, not just a name. */
  private refuse(key: string, code: string): "failed" {
    this.failureReasons.set(key, `routine:${code}`);
    return "failed";
  }

  /** Succeed a State, storing what it published so a replay republishes the same value. */
  private async settle(key: string, state: CompiledState): Promise<void> {
    await this.ctx.options.transitions.transition({
      businessId: this.ctx.run.businessId,
      runId: this.ctx.run.id,
      stateKey: key,
      from: "running",
      to: "succeeded",
      ...(recomputes(state) || !this.produced.has(key)
        ? {}
        : { output: { value: boundedOutput(this.produced.get(key)) } }),
    });
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
