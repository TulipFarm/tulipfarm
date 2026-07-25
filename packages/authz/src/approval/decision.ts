/**
 * Approval validity decisions (SPEC §11.2, §24). Two questions are decided here and nowhere else:
 * whether a principal may record a decision on an Approval, and whether a recorded Approval
 * authorizes one specific use. Both fail closed — an Approval that is expired, consumed, revoked,
 * under-approved, or bound to a different intent authorizes nothing.
 *
 * Denial evidence is a reason code plus the Approval id. Intent arguments, destinations, evidence
 * contents, and Credential references never reach an error message, so audit and error paths
 * cannot leak what the Approval was about (SPEC §13, §20).
 *
 * Storing and mutating Approvals belongs to `@tulipfarm/storage`; this module is a pure decision
 * over a record it is handed.
 */

import { type ApprovalBinding, bindingsMatch } from "./binding";

export type ApprovalRiskLevel = "low" | "medium" | "high";

export type ApprovalOutcome = "approved" | "denied";

export type ApprovalDenialReason =
  | "business_mismatch"
  | "revoked"
  | "expired"
  | "already_used"
  | "self_approval"
  | "approver_not_qualified"
  | "duplicate_approver"
  | "binding_mismatch"
  | "denied"
  | "insufficient_approvals";

export class ApprovalDeniedError extends Error {
  constructor(
    public readonly reason: ApprovalDenialReason,
    message: string
  ) {
    super(message);
    this.name = "ApprovalDeniedError";
  }
}

/** One recorded approver decision. Decisions are append-only; an approver decides at most once. */
export interface ApprovalDecisionRecord {
  readonly approverPrincipalId: string;
  readonly approverRoles: readonly string[];
  readonly outcome: ApprovalOutcome;
  readonly decidedAt: Date;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly businessId: string;
  readonly binding: ApprovalBinding;
  readonly risk: ApprovalRiskLevel;
  /** Roles that may decide this Approval; an approver needs at least one of them. */
  readonly allowedApproverRoles: readonly string[];
  /** Principal that proposed the action — separation of duties bars it from approving. */
  readonly proposerPrincipalId: string;
  /** Principal that will perform the action, when it differs from the proposer. */
  readonly performerPrincipalId?: string;
  /** Agent identity executing the action; an Agent never approves its own action. */
  readonly agentPrincipalId?: string;
  readonly expiresAt: Date;
  readonly decisions: readonly ApprovalDecisionRecord[];
  /** Set the instant the one-use decision was spent; a consumed Approval never applies again. */
  readonly consumedAt?: Date;
  readonly revokedAt?: Date;
}

export interface ApprovalApprover {
  readonly principalId: string;
  readonly businessId: string;
  readonly roles: readonly string[];
}

/** Four-eyes for high risk by default (SPEC §11.2); one qualified approver below it. */
export function requiredApproverCount(risk: ApprovalRiskLevel): number {
  return risk === "high" ? 2 : 1;
}

/** Principals barred from approving because they proposed, will perform, or will execute. */
function prohibitedApprovers(record: ApprovalRecord): readonly string[] {
  return [record.proposerPrincipalId, record.performerPrincipalId, record.agentPrincipalId].filter(
    (id): id is string => id !== undefined
  );
}

/** Throws when the Approval is no longer open to any decision or use. */
function assertOpen(record: ApprovalRecord, now: Date): void {
  if (record.revokedAt !== undefined) {
    throw new ApprovalDeniedError("revoked", `Approval ${record.approvalId} was revoked`);
  }
  if (record.consumedAt !== undefined) {
    throw new ApprovalDeniedError("already_used", `Approval ${record.approvalId} was already used`);
  }
  if (record.expiresAt <= now) {
    throw new ApprovalDeniedError("expired", `Approval ${record.approvalId} has expired`);
  }
}

/**
 * Throws unless `approver` may record a decision on `record`. Precedence: wrong business, then the
 * Approval's own state (revoked, consumed, expired), then separation of duties, then role
 * qualification, then a repeat decision by the same approver.
 */
export function assertApproverEligible(
  record: ApprovalRecord,
  approver: ApprovalApprover,
  now: Date = new Date()
): void {
  if (approver.businessId !== record.businessId) {
    throw new ApprovalDeniedError(
      "business_mismatch",
      `approver does not belong to the business of Approval ${record.approvalId}`
    );
  }
  assertOpen(record, now);
  if (prohibitedApprovers(record).includes(approver.principalId)) {
    throw new ApprovalDeniedError(
      "self_approval",
      `the proposing, performing, or executing principal cannot approve Approval ${record.approvalId}`
    );
  }
  if (!approver.roles.some((role) => record.allowedApproverRoles.includes(role))) {
    throw new ApprovalDeniedError(
      "approver_not_qualified",
      `approver holds no role allowed to decide Approval ${record.approvalId}`
    );
  }
  if (record.decisions.some((entry) => entry.approverPrincipalId === approver.principalId)) {
    throw new ApprovalDeniedError(
      "duplicate_approver",
      `approver already decided Approval ${record.approvalId}`
    );
  }
}

/**
 * Throws unless `record` authorizes the use described by `presented`. Precedence: the Approval's
 * own state (revoked, consumed, expired), then the exact binding — changed arguments, Tool
 * version, target Record, destination, Credential scope, evidence, or Guardrail revision all
 * surface as `binding_mismatch` — then any explicit denial, then the required approver count.
 */
export function assertApprovalUsable(
  record: ApprovalRecord,
  presented: ApprovalBinding,
  now: Date = new Date()
): void {
  assertOpen(record, now);
  if (!bindingsMatch(record.binding, presented)) {
    throw new ApprovalDeniedError(
      "binding_mismatch",
      `Approval ${record.approvalId} was not granted for this intent, evidence, or Guardrail revision`
    );
  }
  if (record.decisions.some((entry) => entry.outcome === "denied")) {
    throw new ApprovalDeniedError("denied", `Approval ${record.approvalId} was denied`);
  }
  const prohibited = prohibitedApprovers(record);
  const approvers = new Set(
    record.decisions
      .filter(
        (entry) =>
          entry.outcome === "approved" &&
          !prohibited.includes(entry.approverPrincipalId) &&
          entry.approverRoles.some((role) => record.allowedApproverRoles.includes(role))
      )
      .map((entry) => entry.approverPrincipalId)
  );
  if (approvers.size < requiredApproverCount(record.risk)) {
    throw new ApprovalDeniedError(
      "insufficient_approvals",
      `Approval ${record.approvalId} lacks the required number of qualified approvers`
    );
  }
}
