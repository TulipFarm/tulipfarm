/**
 * Just-in-time grant issuance (SPEC §12: "Sensitive grants support just-in-time issuance and
 * periodic access review"). A JIT grant is issued for one principal by an approver in the same
 * business, must carry its own expiry (never a standing grant), and separation of duties denies
 * self-approval — an approver can never issue a JIT grant to themselves (SPEC §24 confused
 * deputy / privilege-escalation controls).
 */

import type { AccessGrant } from "./grants";
import type { Principal } from "./principals";

export interface JitGrantRequest {
  readonly principalId: string;
  readonly businessId: string;
  readonly grant: AccessGrant;
  readonly justification: string;
}

export type JitDenialReason = "missing_expiry" | "business_mismatch" | "self_approval";

export class JitDeniedError extends Error {
  constructor(
    public readonly reason: JitDenialReason,
    message: string
  ) {
    super(message);
    this.name = "JitDeniedError";
  }
}

/**
 * Throws unless `request` may be approved by `approver` at `now`: the grant must carry its own
 * expiry, the approver must belong to the same business as the requesting principal, and the
 * approver may not approve a grant for themselves.
 */
export function assertJitGrantIssuable(
  request: JitGrantRequest,
  approver: Pick<Principal, "id" | "businessId">,
  now: Date = new Date()
): void {
  if (!request.grant.expiresAt || request.grant.expiresAt <= now) {
    throw new JitDeniedError("missing_expiry", "a just-in-time grant must carry a future expiry");
  }
  if (approver.businessId !== request.businessId) {
    throw new JitDeniedError(
      "business_mismatch",
      "approver does not belong to the requesting principal's business"
    );
  }
  if (approver.id === request.principalId) {
    throw new JitDeniedError("self_approval", "a principal cannot approve its own JIT grant");
  }
}
