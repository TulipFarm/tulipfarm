import type {
  RoutineAction,
  RoutineDefinition,
  RoutineOnError,
  RoutineState,
} from "@tulipfarm/schema";
import { parseIsoDuration } from "./duration";
import type { EnginePorts, HookInvocation, ResolvedFunction } from "./ports";
import {
  type RunError,
  type RunSnapshot,
  type SelectedRoute,
  type StateExecutionData,
  type StepOutcome,
  stateHookNames,
} from "./types";

/** Max items a foreach state may iterate (V1 bound; `parallel` is deferred anyway). */
export const FOREACH_CAP = 1000;

const EXPR_RE = /^\$\{([\s\S]+)\}$/;

class StateFailure extends Error {
  constructor(
    readonly runError: RunError,
    /** Retry policy of the failing action, when declared. */
    readonly retryRef?: string
  ) {
    super(runError.message);
  }
}

function findState(def: RoutineDefinition, name: string): RoutineState {
  const state = def.states.find((s) => s.name === name);
  if (!state) throw new Error(`state "${name}" not found in definition`);
  return state;
}

function resolveFunction(def: RoutineDefinition, refName: string): ResolvedFunction {
  const fn = (def.functions ?? []).find((f) => f.name === refName);
  if (!fn) throw new Error(`function "${refName}" not found in definition`);
  const [kind, ...rest] = fn.operation.split(":");
  return { kind: kind as ResolvedFunction["kind"], target: rest.join(":") };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Set a dot-path (e.g. "lastId" or "report.total") inside the context object. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.replace(/^context\./, "").split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[part] = created;
      node = created;
    }
  }
  node[parts[parts.length - 1] ?? path] = value;
}

/**
 * Executes exactly one state of a run and reports what should happen next. Pure with
 * respect to I/O — every side effect goes through `ports`. The caller persists the
 * outcome before acting on it (crash safety), so this function may be re-invoked for
 * the same state after a crash.
 */
export async function executeState(run: RunSnapshot, ports: EnginePorts): Promise<StepOutcome> {
  const def = run.definition;
  let state: RoutineState;
  try {
    state = findState(def, run.currentState);
  } catch (err) {
    return fail({ name: "bad_definition", message: String(err), state: run.currentState });
  }

  // human_approval gate (ROUT-V1-003): pause before executing, resume on decision.
  if (state["x-autonomy-level"] === "human_approval") {
    if (run.approvalOutcome === undefined) {
      return {
        type: "wait_approval",
        request: {
          stateName: state.name,
          channels: state["x-approval-channel"] ?? ["ui"],
          summary: run.context,
        },
      };
    }
    if (run.approvalOutcome === "denied") {
      return routeError(
        run,
        state,
        { name: "approval_denied", message: `state "${state.name}" was denied`, state: state.name },
        undefined,
        stateData(state.name, run.context)
      );
    }
  }

  const hooks = stateHookNames(state.name);
  let context = { ...run.context };
  let executionData = stateData(state.name, context);
  let emittingEntry = false;

  try {
    if (state.stateDataFilter?.input) {
      const filtered = await evalExpr(ports, state.stateDataFilter.input, scopeOf(run, context));
      if (isRecord(filtered)) context = filtered;
    }
    executionData = stateData(state.name, context);

    emittingEntry = true;
    await ports.emit({
      type: "state.entered",
      data: {
        state: state.name,
        stateType: state.type,
        input: executionData.input,
        attempt: (run.attemptCounts[state.name] ?? 0) + 1,
      },
    });
    emittingEntry = false;

    const invocation: HookInvocation = {
      runId: run.runId,
      slug: run.slug,
      stateName: state.name,
      context,
      trigger: run.trigger,
    };
    if (ports.hasHook(hooks.before)) await ports.runHook(hooks.before, invocation);

    const body = await withStateTimeout(run, state, context, ports);

    if (state.stateDataFilter?.output) {
      const filtered = await evalExpr(ports, state.stateDataFilter.output, scopeOf(run, context));
      if (isRecord(filtered)) context = filtered;
    }

    if (ports.hasHook(hooks.after)) {
      await ports.runHook(hooks.after, { ...invocation, context });
    }

    executionData.output = snapshot(context);

    if (body?.sleep) {
      return {
        type: "sleep",
        ...body.sleep,
        context,
        route: body.route,
        stateData: executionData,
      };
    }

    const route = body?.route ?? stateRoute(state.name, state.transition, state.end);
    if ("end" in route) {
      return { type: "complete", output: context, route, stateData: executionData };
    }
    if (route.target) {
      return {
        type: "continue",
        nextState: route.target,
        context,
        route,
        stateData: executionData,
      };
    }
    throw new StateFailure({
      name: "bad_definition",
      message: `state "${state.name}" has neither transition nor end`,
      state: state.name,
    });
  } catch (err) {
    if (emittingEntry) throw err;
    let failure: StateFailure;
    if (err instanceof StateFailure) {
      failure = err;
    } else {
      failure = new StateFailure({
        name: errorName(err),
        message: err instanceof Error ? err.message : String(err),
        state: state.name,
      });
    }
    return routeError(run, state, failure.runError, failure.retryRef, executionData);
  }
}

/**
 * Per-state timeout (ROUT-V1-007): races the state body against
 * `timeouts.stateExecTimeout`. A timeout becomes a `timeout` StateFailure routed through
 * the normal retry/onErrors machinery. The caller's CAS-guarded persistence makes the
 * race safe: whichever outcome persists first wins, the loser's transition misses.
 */
async function withStateTimeout(
  run: RunSnapshot,
  state: RoutineState,
  context: Record<string, unknown>,
  ports: EnginePorts
): Promise<StateBodyResult | undefined> {
  const iso = state.timeouts?.stateExecTimeout;
  if (!iso) return runStateBody(run, state, context, ports);

  const ms = parseIsoDuration(iso);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new StateFailure({
          name: "timeout",
          message: `state "${state.name}" exceeded stateExecTimeout ${iso}`,
          state: state.name,
        })
      );
    }, ms);
  });
  try {
    return await Promise.race([runStateBody(run, state, context, ports), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Route or suspension selected by the State body. */
interface StateBodyResult {
  route: SelectedRoute;
  sleep?: { until: Date; nextState: string | null };
}

/**
 * Executes the state's body against `context` (mutating it). Returns the selected route
 * for Sleep/Switch States; the shared completion path in `executeState` takes over.
 */
async function runStateBody(
  run: RunSnapshot,
  state: RoutineState,
  context: Record<string, unknown>,
  ports: EnginePorts
): Promise<StateBodyResult | undefined> {
  switch (state.type) {
    case "inject": {
      Object.assign(context, state.data);
      return undefined;
    }
    case "sleep": {
      const until = new Date(ports.now().getTime() + parseIsoDuration(state.duration));
      return {
        route: stateRoute(state.name, state.transition, state.end),
        sleep: { until, nextState: state.end ? null : (state.transition ?? null) },
      };
    }
    case "switch": {
      for (const [index, cond] of state.dataConditions.entries()) {
        const value = await evalExpr(ports, cond.condition, scopeOf(run, context));
        if (value) {
          return {
            route: {
              kind: "condition",
              index,
              ...routeDestination(state.name, cond.transition, cond.end),
            },
          };
        }
      }
      if (state.defaultCondition) {
        return {
          route: {
            kind: "default",
            ...routeDestination(
              state.name,
              state.defaultCondition.transition,
              state.defaultCondition.end
            ),
          },
        };
      }
      throw new StateFailure({
        name: "no_matching_condition",
        message: `switch "${state.name}" matched no condition and has no default`,
        state: state.name,
      });
    }
    case "operation": {
      for (const action of state.actions) {
        await runOneAction(run, state.name, action, context, {}, ports);
      }
      return undefined;
    }
    case "foreach": {
      const collection = await evalExpr(ports, state.inputCollection, scopeOf(run, context));
      if (!Array.isArray(collection)) {
        throw new StateFailure({
          name: "bad_collection",
          message: `foreach "${state.name}" inputCollection did not yield an array`,
          state: state.name,
        });
      }
      if (collection.length > FOREACH_CAP) {
        throw new StateFailure({
          name: "foreach_cap_exceeded",
          message: `foreach "${state.name}" got ${collection.length} items (cap ${FOREACH_CAP})`,
          state: state.name,
        });
      }
      const param = state.iterationParam ?? "item";
      for (const item of collection) {
        for (const action of state.actions) {
          await runOneAction(run, state.name, action, context, { [param]: item }, ports);
        }
      }
      return undefined;
    }
  }
}

/**
 * Runs a single action: resolves the function, evaluates `${...}` argument expressions,
 * dispatches through ports (tool/agent via runAction, hook via runHook), then applies
 * actionDataFilter. Throws StateFailure carrying retryRef on failure.
 */
async function runOneAction(
  run: RunSnapshot,
  stateName: string,
  action: RoutineAction,
  context: Record<string, unknown>,
  extraScope: Record<string, unknown>,
  ports: EnginePorts
): Promise<void> {
  const scope = { ...scopeOf(run, context), ...extraScope };
  let result: unknown;
  try {
    const fn = resolveFunction(run.definition, action.functionRef.refName);
    const args = await evalArguments(ports, action.functionRef.arguments ?? {}, scope);
    result =
      fn.kind === "hook"
        ? await ports.runHook(
            fn.target,
            {
              runId: run.runId,
              slug: run.slug,
              stateName,
              context,
              trigger: run.trigger,
            },
            args
          )
        : await ports.runAction(fn, args, run);
  } catch (err) {
    throw new StateFailure(
      {
        name: errorName(err),
        message: err instanceof Error ? err.message : String(err),
        state: stateName,
      },
      action.retryRef
    );
  }

  await ports.emit({
    type: "action.completed",
    data: { state: stateName, action: action.name ?? action.functionRef.refName },
  });

  const filter = action.actionDataFilter;
  if (filter?.toStateData) {
    const value = filter.results
      ? await evalExpr(ports, filter.results, { ...scope, result })
      : result;
    setPath(context, filter.toStateData, value);
  }
}

/**
 * Retry + onErrors routing (ROUT-V1-007). Retry policy (via the failing action's
 * retryRef) wins while attempts remain; then onErrors (`errorRef` match or "*") routes
 * to a recovery state or a clean end; otherwise the run fails.
 */
function routeError(
  run: RunSnapshot,
  state: RoutineState,
  error: RunError,
  retryRef: string | undefined,
  executionData: StateExecutionData
): StepOutcome {
  if (retryRef) {
    const policy = (run.definition.retries ?? []).find((r) => r.name === retryRef);
    if (policy) {
      const attempt = (run.attemptCounts[state.name] ?? 0) + 1;
      if (attempt < policy.maxAttempts) {
        const base = policy.delay ? parseIsoDuration(policy.delay) : 1_000;
        const delayMs = Math.round(base * (policy.multiplier ?? 1) ** (attempt - 1));
        return { type: "retry", delayMs, attempt, error, stateData: executionData };
      }
    }
  }

  const match = matchOnError(state.onErrors, error);
  if (match) {
    const { index, route } = match;
    const selectedRoute: SelectedRoute = {
      kind: "error",
      index,
      error,
      ...routeDestination(state.name, route.transition, route.end),
    };
    if (route.transition) {
      return {
        type: "continue",
        nextState: route.transition,
        context: { ...run.context },
        route: selectedRoute,
        stateData: executionData,
      };
    }
    if (route.end) {
      return {
        type: "complete",
        output: { ...run.context, error },
        route: selectedRoute,
        stateData: executionData,
      };
    }
  }
  return { type: "fail", error, stateData: executionData };
}

function matchOnError(
  onErrors: RoutineOnError[] | undefined,
  error: RunError
): { index: number; route: RoutineOnError } | undefined {
  const index = (onErrors ?? []).findIndex(
    (route) => route.errorRef === error.name || route.errorRef === "*"
  );
  const route = onErrors?.[index];
  return route ? { index, route } : undefined;
}

function stateRoute(
  state: string,
  transition: string | undefined,
  end: boolean | undefined
): SelectedRoute {
  if (transition) return { kind: "transition", target: transition };
  if (end) return { kind: "end", end: true };
  throw invalidRoute(state);
}

function routeDestination(
  state: string,
  transition: string | undefined,
  end: boolean | undefined
): { target: string } | { end: true } {
  if (transition) return { target: transition };
  if (end) return { end: true };
  throw invalidRoute(state);
}

function invalidRoute(state: string): StateFailure {
  return new StateFailure({
    name: "bad_definition",
    message: `state "${state}" has neither transition nor end`,
    state,
  });
}

function stateData(state: string, input: Record<string, unknown>): StateExecutionData {
  return { state, input: snapshot(input) };
}

function snapshot(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function scopeOf(run: RunSnapshot, context: Record<string, unknown>): Record<string, unknown> {
  return { context, trigger: { type: run.trigger.type, payload: run.trigger.payload } };
}

async function evalExpr(
  ports: EnginePorts,
  expr: string,
  scope: Record<string, unknown>
): Promise<unknown> {
  return ports.evalExpression(expr, scope);
}

/** Deep-walks literal arguments; string values shaped "${ <js> }" are evaluated. */
async function evalArguments(
  ports: EnginePorts,
  args: Record<string, unknown>,
  scope: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const walk = async (value: unknown): Promise<unknown> => {
    if (typeof value === "string") {
      const m = EXPR_RE.exec(value);
      return m ? ports.evalExpression(m[1].trim(), scope) : value;
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = await walk(v);
      return out;
    }
    return value;
  };
  return (await walk(args)) as Record<string, unknown>;
}

function errorName(err: unknown): string {
  if (err instanceof Error && err.name !== "Error") return err.name;
  return "action_failed";
}

function fail(error: RunError): StepOutcome {
  return { type: "fail", error };
}
