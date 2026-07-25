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

/**
 * Open the durable Approval wait for an `approval` State. The wait carries the authored approver
 * roles as canonical principals, so wrong-actor and wrong-schema deliveries are denied by the
 * durable wait itself rather than by anything reimplemented here.
 */
export function planApprovalWait(state: CompiledState, ctx: StateWaitContext): RegisterWaitInput {
  const roles = requireRoles(state, "approverRoles");
  return planStateWait(state, ctx, {
    kind: "approval",
    principals: roles.map((role) => `role:${role}`),
  });
}

/**
 * Resolve the Approval. A rejection is a decided negative outcome and fails the State unless an
 * `approval_rejected` handler claims it; an expiry is nobody's decision, so it parks the Run for
 * attention instead of being read as either an approval or a rejection.
 */
export function resolveApproval(state: CompiledState, result: ApprovalResult): StateResumeDecision {
  if (result === "approved") return continueState(state);
  if (result === "rejected") return resolveErrorPath(state, "approval_rejected", "failed");
  return resolveErrorPath(state, "wait_expired", "attention");
}
