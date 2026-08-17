import type { AuthorityLayer } from "@tulipfarm/authz";
import {
  type ArtifactService,
  agentOutputSchema,
  type CompiledRoutine,
  type CompiledState,
  compileRoutine,
  decideBranch,
  type IdentityCeiling,
  InMemoryStateConcurrencyStore,
  InMemoryStateContentionStore,
  InMemoryStateRetryStore,
  planAgentInvocation,
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
import type { RoutineAgentPort } from "./agent-port";
import type { RoutineApprovalPort } from "./approval-port";
import {
  type ConcurrencyGuardContext,
  concurrencyBackoffElapsed,
  underConcurrencyKey,
} from "./concurrency-guard";
import type { WorkerRoutineDefinitionLoader } from "./definition-loader";
import {
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
  type StateOutputs,
  TOOL_ERROR_PREFIX,
} from "./execution-support";
import { type FanOutContext, runComposite } from "./fan-out";
import type { RoutineToolPort } from "./tool-port";
import {
  openApproval,
  openWait,
  type RoutineWaitPort,
  resumeApproval,
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

function defaultIdentityCeiling(run: PersistedRun): IdentityCeiling {
  return {
    principalKind: run.identity.effectiveSubject.kind,
    principalId: run.identity.effectiveSubject.id,
    grants: [],
    maxRiskClass: "low",
  };
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

    // A `waiting` State is resolved by its wait, not by re-running it — unless the wait it is on
    // is a concurrency backoff, which exists precisely to bring it back *into* execution.
    if (row.status === "waiting" && !(await this.backoffElapsed(state, key))) {
      const resumed =
        state.type === "approval"
          ? await resumeApproval(this.waitGate(), state, key, row)
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

      outcome = await this.underConcurrencyKey(state, key, () =>
        state.type === "branch"
          ? Promise.resolve(decideBranch(state, scope).outcome)
          : state.type === "tool"
            ? this.runTool(state, key, scope)
            : state.type === "agent"
              ? this.runAgent(state, key, row, scope)
              : runComposite(this.fanOut(), state, key, scope, outputs, depth)
      );
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
