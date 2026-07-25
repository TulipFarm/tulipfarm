import type { RegisterWaitInput } from "../../waits";
import type { CompiledState } from "../compiler";
import {
  continueState,
  planStateWait,
  requireRoles,
  resolveErrorPath,
  type StateResumeDecision,
  type StateWaitContext,
} from "./wait-plan";

export type HumanTaskResult = "completed" | "declined" | "expired";

export interface HumanTaskAssignment {
  readonly stateKey: string;
  readonly roles: readonly string[];
  /** The same roles as canonical principals — exactly who may signal the wait. */
  readonly principals: readonly string[];
}

/**
 * The assignment a `human_task` State publishes. It names roles, never an individual: picking a
 * person is the assignment surface's job, and the durable wait stays authorized to the whole role
 * so a hand-off does not silently lock the Run to one absent human.
 */
export function humanTaskAssignment(state: CompiledState): HumanTaskAssignment {
  const roles = requireRoles(state, "assigneeRoles");
  return { stateKey: state.name, roles, principals: roles.map((role) => `role:${role}`) };
}

export function planHumanTaskWait(state: CompiledState, ctx: StateWaitContext): RegisterWaitInput {
  return planStateWait(state, ctx, {
    kind: "human_task",
    principals: humanTaskAssignment(state).principals,
  });
}

/** Completion continues; a decline fails unless handled; an expiry parks for attention. */
export function resolveHumanTask(
  state: CompiledState,
  result: HumanTaskResult
): StateResumeDecision {
  if (result === "completed") return continueState(state);
  if (result === "declined") return resolveErrorPath(state, "task_declined", "failed");
  return resolveErrorPath(state, "wait_expired", "attention");
}
