import type { RegisterWaitInput } from "../../waits";
import type { CompiledState } from "../compiler";
import { RoutineStepError } from "./step";
import { waitSchemaRef } from "./wait-plan";

/** `wait` has no principals, resolves only by deadline sweep, and must have bounded duration. */

export interface TimerWaitContext {
  readonly businessId: string;
  readonly runId: string;
  readonly waitId: string;
  readonly stateKey: string;
  readonly now: string;
}

function durationMsOf(state: CompiledState): number {
  if (state.definition.type !== "wait") {
    throw new RoutineStepError("deadline_not_bounded", state.name);
  }
  const waitFor = state.definition.waitFor;
  if (typeof waitFor !== "object" || waitFor === null) {
    throw new RoutineStepError("deadline_not_bounded", state.name);
  }
  const value = (waitFor as Record<string, unknown>).durationMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RoutineStepError("deadline_not_bounded", state.name);
  }
  return value;
}

export function isTimerWait(state: CompiledState): boolean {
  if (state.definition.type !== "wait") return false;
  const waitFor = state.definition.waitFor;
  if (typeof waitFor !== "object" || waitFor === null) return false;
  return (waitFor as Record<string, unknown>).kind === "timer";
}

/**
 * Plan a durable timer. Nothing here performs I/O: the caller registers the wait and only then
 * parks the State, so a crash in between replays to the same plan under the same wait id.
 */
export function planTimerWait(state: CompiledState, ctx: TimerWaitContext): RegisterWaitInput {
  if (!isTimerWait(state)) throw new RoutineStepError("wait_kind_not_supported", state.name);
  const durationMs = durationMsOf(state);
  return {
    id: ctx.waitId,
    businessId: ctx.businessId,
    runId: ctx.runId,
    stateKey: ctx.stateKey,
    kind: "timer",
    aggregation: "first",
    schemaRef: waitSchemaRef(state, "timer"),
    allowedPrincipals: [],
    expectedSignals: 1,
    quorum: null,
    deadlineAt: new Date(Date.parse(ctx.now) + durationMs).toISOString(),
    createdAt: ctx.now,
  };
}
