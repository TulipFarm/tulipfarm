/**
 * External identity → principal mapping (SPEC §12): Slack/Telegram/GitHub/etc. subjects map to
 * one verified TulipFarm principal per business. "Thread/channel membership alone never
 * authorizes business data" — an unmapped sender, an expired mapping, or a sender mapped to a
 * different principal than the conversation owner must never inherit that owner's authority.
 * This closes the known Conversation-owner substitution fixture: today's ingress path lets any
 * external sender chime into a mapped thread and silently run the turn as the thread's owner
 * (see apps/api/src/ingress/service.ts `handleChat`); the assertion below is the fail-closed
 * check that decision must be routed through.
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

/**
 * Throws unless the sender's own verified mapping resolves to `conversationOwnerPrincipalId`.
 * An unmapped, expired, cross-business, or differently-mapped sender never inherits the
 * conversation owner's authority — denying the known Conversation-owner substitution fixture.
 */
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
