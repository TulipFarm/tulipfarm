/**
 * External senders must map to their own verified principal; thread membership never inherits a
 * conversation owner's authority.
 */

export interface ExternalIdentityMapping {
  readonly businessId: string;
  readonly provider: string;
  readonly externalSubject: string;
  readonly principalId: string;
  readonly verifiedAt: Date;
  /** Absent means no expiry (a standing verified mapping). */
  readonly expiresAt?: Date;
}

export type ExternalIdentityDenialReason =
  | "unmapped"
  | "expired"
  | "business_mismatch"
  | "substitution";

export class ExternalIdentityDeniedError extends Error {
  constructor(
    public readonly reason: ExternalIdentityDenialReason,
    message: string
  ) {
    super(message);
    this.name = "ExternalIdentityDeniedError";
  }
}

/** Throws unless `mapping` is a live, business-scoped verified mapping at `now`. */
export function assertExternalIdentityMapped(
  mapping: ExternalIdentityMapping | undefined,
  businessId: string,
  now: Date = new Date()
): asserts mapping is ExternalIdentityMapping {
  if (!mapping) {
    throw new ExternalIdentityDeniedError("unmapped", "external subject has no verified mapping");
  }
  if (mapping.businessId !== businessId) {
    throw new ExternalIdentityDeniedError(
      "business_mismatch",
      `mapping for ${mapping.externalSubject} belongs to a different business`
    );
  }
  if (mapping.expiresAt && mapping.expiresAt <= now) {
    throw new ExternalIdentityDeniedError(
      "expired",
      `mapping for ${mapping.externalSubject} has expired`
    );
  }
}

/** Denies unmapped, expired, cross-business, or differently mapped external senders. */
export function assertConversationSenderAuthorized(
  mapping: ExternalIdentityMapping | undefined,
  conversationOwnerPrincipalId: string,
  businessId: string,
  now: Date = new Date()
): void {
  assertExternalIdentityMapped(mapping, businessId, now);
  if (mapping.principalId !== conversationOwnerPrincipalId) {
    throw new ExternalIdentityDeniedError(
      "substitution",
      `external subject ${mapping.externalSubject} does not authenticate the conversation owner`
    );
  }
}
