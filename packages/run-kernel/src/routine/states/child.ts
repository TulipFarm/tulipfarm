import { CHILD_COMPLETION_SCHEMA_REF } from "../../child-completion";
import type { ChildAuthority, RequestedChildAuthority } from "../../children";
import { narrowChildAuthority } from "../../children";
import type { RegisterWaitInput } from "../../waits";
import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { RoutineStepError } from "./step";
import {
  continueState,
  deadlineMsOf,
  planStateWait,
  resolveErrorPath,
  type StateResumeDecision,
  type StateWaitContext,
} from "./wait-plan";

export type ChildRunResult = "succeeded" | "failed" | "cancelled" | "expired";

export interface ChildRunContext extends StateWaitContext {
  readonly childRunId: string;
  readonly parentAuthority: ChildAuthority;
}

export interface ChildRunCommand {
  readonly businessId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly routineRef: { readonly name: string; readonly version: string };
  /** Already intersected with the parent's authority — a child can never run wider. */
  readonly authority: ChildAuthority;
  readonly mode: "wait" | "detach";
}

export interface ChildRunPlan {
  readonly command: ChildRunCommand;
  readonly wait: RegisterWaitInput | null;
}

/** What a `child_routine` State asks for, once its authored mappings are resolved. */
export interface ChildRoutineCall {
  readonly routineRef: { readonly name: string; readonly version: string };
  readonly mode: "wait" | "detach";
  readonly input: Record<string, unknown>;
  /**
   * How long the caller may stay parked. Required in `wait` mode and refused when absent, so a
   * Routine can never park on a child forever; `detach` never parks, so it carries none.
   */
  readonly deadlineMs: number | null;
}

/**
 * Resolves a `child_routine` State into the call the host must make.
 *
 * Kept in the kernel rather than the Worker so the callee name, the mode and the caller's
 * deadline are validated once, on the same terms as every other State's plan.
 */
export function planChildRoutineCall(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): ChildRoutineCall {
  const mode = childRoutineMode(state);
  return {
    routineRef: routineRefOf(state),
    mode,
    input: resolveRoutineStateInput(state, scope),
    deadlineMs: mode === "detach" ? null : deadlineMsOf(state),
  };
}

function childRoutineMode(state: CompiledState): "wait" | "detach" {
  return state.definition.type === "child_routine" && state.definition.mode === "detach"
    ? "detach"
    : "wait";
}

function routineRefOf(state: CompiledState): { name: string; version: string } {
  if (state.definition.type !== "child_routine") {
    throw new RoutineStepError("missing_routine_ref", state.name);
  }
  const value = state.definition.routineRef;
  if (typeof value === "object" && value !== null) {
    const { name, version } = value as Record<string, unknown>;
    if (typeof name === "string" && typeof version === "string") return { name, version };
  }
  throw new RoutineStepError("missing_routine_ref", state.name);
}

/**
 * Child commands carry narrowed authority; `wait` joins by bounded durable wait, `detach` does not.
 */
export function planChildRun(
  state: CompiledState,
  ctx: ChildRunContext,
  requested: RequestedChildAuthority
): ChildRunPlan {
  const routineRef = routineRefOf(state);
  const authority = narrowChildAuthority(ctx.parentAuthority, requested);
  const mode = childRoutineMode(state);

  return {
    command: {
      businessId: ctx.businessId,
      parentRunId: ctx.runId,
      childRunId: ctx.childRunId,
      routineRef,
      authority,
      mode,
    },
    wait:
      mode === "detach"
        ? null
        : planStateWait(state, ctx, {
            kind: "child_run",
            principals: [`run:${ctx.childRunId}`],
            // Pinned, not derived: the child reports through `signalChildCompletion`, which always
            // delivers `CHILD_COMPLETION_SCHEMA_REF`, and `authorizeSignal` refuses any mismatch as
            // `wrong_schema`. A per-State ref would park the caller on a wait nothing can redeem.
            schemaRef: CHILD_COMPLETION_SCHEMA_REF,
          }),
  };
}

/** Failed child Runs are handleable outcomes; cancelled or expired children park attention. */
export function resolveChildRun(state: CompiledState, result: ChildRunResult): StateResumeDecision {
  if (result === "succeeded") return continueState(state);
  if (result === "failed") return resolveErrorPath(state, "child_failed", "failed");
  if (result === "cancelled") return resolveErrorPath(state, "child_cancelled", "attention");
  return resolveErrorPath(state, "wait_expired", "attention");
}
