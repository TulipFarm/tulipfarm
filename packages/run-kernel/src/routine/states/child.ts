import type { ChildAuthority, RequestedChildAuthority } from "../../children";
import { narrowChildAuthority } from "../../children";
import type { RegisterWaitInput } from "../../waits";
import type { CompiledState } from "../compiler";
import { RoutineStepError } from "./step";
import {
  continueState,
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
  /** The durable child-Run wait, or `null` for a detached child the parent does not join. */
  readonly wait: RegisterWaitInput | null;
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
 * Plan a `child_routine` State. The command carries the *narrowed* authority the child will run
 * under, so an amplification attempt is denied here rather than clipped silently. In `wait` mode
 * the parent joins through a bounded durable wait signalled by the child Run itself; in `detach`
 * mode there is no wait and the parent continues immediately.
 */
export function planChildRun(
  state: CompiledState,
  ctx: ChildRunContext,
  requested: RequestedChildAuthority
): ChildRunPlan {
  const routineRef = routineRefOf(state);
  const authority = narrowChildAuthority(ctx.parentAuthority, requested);
  const mode =
    state.definition.type === "child_routine" && state.definition.mode === "detach"
      ? "detach"
      : "wait";

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
          }),
  };
}

/**
 * Resolve the parent State once the child settled. A failed child is a decided outcome the parent
 * may handle; a cancelled or expired child is not — the parent parks for attention rather than
 * treating an unfinished child as either success or failure.
 */
export function resolveChildRun(state: CompiledState, result: ChildRunResult): StateResumeDecision {
  if (result === "succeeded") return continueState(state);
  if (result === "failed") return resolveErrorPath(state, "child_failed", "failed");
  if (result === "cancelled") return resolveErrorPath(state, "child_cancelled", "attention");
  return resolveErrorPath(state, "wait_expired", "attention");
}
