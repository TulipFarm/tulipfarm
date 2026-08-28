import {
  type CompiledExpression,
  type CompiledState,
  inputNodeExpressions,
  isTimerWait,
  RoutineStepError,
  type StateStatus,
} from "@tulipfarm/run-kernel";
import type { PersistedState } from "@tulipfarm/storage";

/**
 * The vocabulary and admission checks of the Routine executor.
 *
 * A Routine State only runs here when this module can answer yes to two questions: is the State a
 * kind this process can settle deterministically, and can every expression it reads be rebuilt
 * from the Run's immutable request Artifact? Anything else is refused by name so an operator sees
 * which capability was missing rather than a Run that silently did nothing.
 */

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

export interface ManualRoutineRequest {
  readonly slug: string;
  readonly inputs: Record<string, unknown>;
}

/** How one chain of States — a Run's main line, a fan-out unit, or a loop body — ended. */
export type ChainOutcome =
  | "succeeded"
  | "failed"
  | "waiting"
  | "needs_reconciliation"
  | "cancelled";

export type StateOutputs = Record<string, { readonly output: unknown }>;

export const CLAIM_PATH: readonly StateStatus[] = ["ready", "claimed", "running"];

/** Expression roots this executor can reconstruct from the Run's immutable request Artifact. */
export const SUPPORTED_ROOTS: ReadonlySet<string> = new Set(["input", "states", "item", "loop"]);

/** Deterministic State types with no external effect and no Context this executor cannot build. */
export const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "agent",
  "approval",
  "branch",
  "child_routine",
  "compute",
  "emit",
  "tool",
  "wait",
  "parallel",
  "foreach",
  "repeat_until",
  "script",
  "action",
]);

/** Error reference an expired `wait` raises, so an authored `onError` handler can claim it. */
export const WAIT_TIMED_OUT = "wait_timed_out";

/** Prefix an authored `onError` handler claims a refused or failed Tool dispatch by. */
export const TOOL_ERROR_PREFIX = "tool_";

/** Prefix an authored `onError` handler claims a refused or failed Agent answer by. */
export const AGENT_ERROR_PREFIX = "agent_";

/** Prefix an authored `onError` handler claims a failed `script` State by. */
export const SCRIPT_ERROR_PREFIX = "script_";

/** Prefix an authored `onError` handler claims a refused or failed `action` State by. */
export const ACTION_ERROR_PREFIX = "action_";

export function artifactId(payloadRef: unknown, state: string): string {
  if (typeof payloadRef !== "string" || !payloadRef.startsWith("artifact:")) {
    throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  }
  const id = payloadRef.slice("artifact:".length);
  if (id.length === 0) throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  return id;
}

export function manualRequest(
  content: Record<string, unknown>,
  state: string
): ManualRoutineRequest {
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

export function assertSupportedExpression(expression: CompiledExpression, state: string): void {
  for (const reference of expression.references) {
    const [root] = reference.split(".");
    if (!SUPPORTED_ROOTS.has(root ?? "")) {
      throw new RoutineExecutionRefusal("unsupported_context", state);
    }
  }
}

export function assertSupportedState(state: CompiledState): void {
  if (!SUPPORTED_TYPES.has(state.type)) {
    throw new RoutineExecutionRefusal("unsupported_state", state.name);
  }
  for (const condition of state.conditions) {
    assertSupportedExpression(condition.condition, state.name);
  }
  if (state.iterator !== null) assertSupportedExpression(state.iterator, state.name);
  // A `compute` State's input mappings are its whole body, so an unbuildable root is refused here
  // by name rather than surfacing later as an unevaluable input on a State that looks inert.
  if (state.type === "compute") assertSupportedInput(state);
  // A `script`'s and an `action`'s inputs are likewise their whole body — the function's arguments
  // and the Tool's arguments — so an unbuildable root is refused here rather than at dispatch.
  if (state.type === "script" || state.type === "action") assertSupportedInput(state);
  // An `event` wait is resolved by a signal nothing in this process delivers; parking it is the
  // only honest answer, because opening it would strand the Run on a wait with no signaller.
  if (state.type === "wait" && !isTimerWait(state)) {
    throw new RoutineExecutionRefusal("unsupported_wait", state.name);
  }
}

export function assertSupportedInput(state: CompiledState): void {
  for (const mapping of state.inputs) {
    for (const expression of inputNodeExpressions(mapping.node)) {
      assertSupportedExpression(expression, state.name);
    }
  }
}

export function progressionFrom(status: PersistedState["status"]): readonly StateStatus[] | null {
  // `waiting` re-enters the same claim path: `waiting → ready → claimed → running`.
  if (status === "pending" || status === "waiting") return CLAIM_PATH;
  const index = CLAIM_PATH.indexOf(status as StateStatus);
  return index >= 0 ? CLAIM_PATH.slice(index + 1) : null;
}

export function isRefusal(error: unknown): error is RoutineExecutionRefusal | RoutineStepError {
  return error instanceof RoutineExecutionRefusal || error instanceof RoutineStepError;
}

export type ClassifiableOutcome = { readonly kind: string; readonly retryable?: boolean };

/**
 * A failure a State's `retry` policy may re-attempt: only one a port explicitly marked
 * `retryable`. Absence of the flag (every `tool` failure, by the effect ledger's design) is
 * terminal, so an unmarked failure is never retried.
 */
export function isRetryableFailure(outcome: ClassifiableOutcome): boolean {
  return outcome.kind === "failed" && outcome.retryable === true;
}
