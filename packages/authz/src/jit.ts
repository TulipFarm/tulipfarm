/** JIT grants require same-business approval, explicit expiry, and no self-approval. */

import type { AccessGrant } from "./grants";
import type { Principal } from "./principals";

export interface JitGrantRequest {
  readonly principalId: string;
  readonly businessId: string;
  readonly grant: AccessGrant;
  readonly justification: string;
}

export type JitDenialReason =
  | "missing_expiry"
  | "business_mismatch"
  | "self_approval"
  | "approver_inactive";

export class JitDeniedError extends Error {
  constructor(
    public readonly reason: JitDenialReason,
    message: string
  ) {
    super(message);
    this.name = "JitDeniedError";
  }
}

/** Throws unless the approver is same-business, distinct from requester, and the grant expires. */
export function assertJitGrantIssuable(
  request: JitGrantRequest,
  approver: Pick<Principal, "id" | "businessId" | "status" | "expiresAt">,
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
  if (
    approver.status !== "active" ||
    (approver.expiresAt !== undefined && approver.expiresAt <= now)
  ) {
    throw new JitDeniedError("approver_inactive", "approver is not an active principal");
  }
  if (approver.id === request.principalId) {
    throw new JitDeniedError("self_approval", "a principal cannot approve its own JIT grant");
  }
}
