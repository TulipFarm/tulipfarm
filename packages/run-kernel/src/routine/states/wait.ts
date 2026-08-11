import type { RegisterWaitInput } from "../../waits";
import type { CompiledState } from "../compiler";
import { RoutineStepError } from "./step";
import { waitSchemaRef } from "./wait-plan";

/**
 * The `wait` State (SPEC §9.2). Unlike the States in `wait-plan.ts`, nobody signals a timer: it is
 * resolved by the deadline sweep alone, which is why it is the one wait kind that names no
 * principals. An authored `wait` with no bounded duration is a denial — a Run parked on an
 * unbounded timer is a Run nothing will ever resume.
 */

export interface TimerWaitContext {
  readonly businessId: string;
  readonly runId: string;
  readonly waitId: string;
  /** Durable State occurrence key; it may differ from the authored name inside a fan-out. */
  readonly stateKey: string;
  /** ISO-8601 instant the wait is opened at. */
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

/** True when the authored State waits on the clock rather than on an external event. */
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
