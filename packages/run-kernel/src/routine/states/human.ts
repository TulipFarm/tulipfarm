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
  readonly principals: readonly string[];
}

/** Human-task waits authorize roles, not individuals, so hand-offs remain valid. */
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
