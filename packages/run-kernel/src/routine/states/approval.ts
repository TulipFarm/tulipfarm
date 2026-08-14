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

export type ApprovalResult = "approved" | "rejected" | "expired";

/** Approval waits carry canonical approver roles and deny wrong actors or schemas. */
export function planApprovalWait(state: CompiledState, ctx: StateWaitContext): RegisterWaitInput {
  const roles = requireRoles(state, "approverRoles");
  return planStateWait(state, ctx, {
    kind: "approval",
    principals: roles.map((role) => `role:${role}`),
  });
}

/** Rejection is decided failure unless handled; expiry parks for attention. */
export function resolveApproval(state: CompiledState, result: ApprovalResult): StateResumeDecision {
  if (result === "approved") return continueState(state);
  if (result === "rejected") return resolveErrorPath(state, "approval_rejected", "failed");
  return resolveErrorPath(state, "wait_expired", "attention");
}
