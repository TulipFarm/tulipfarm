/**
 * Sponsored, expiring guest principals (SPEC §12): "Guests require a sponsor, expiry, and
 * explicit access grants." A guest carries no authority beyond its own grants — it never
 * inherits its sponsor's roles or grants (non-amplification) — and stops being usable the
 * instant it is revoked or past expiry, regardless of its stored grants.
 */

import type { AccessGrant } from "./grants";
import type { Principal } from "./principals";

export type GuestStatus = "active" | "revoked";

export interface Guest {
  readonly principalId: string;
  readonly businessId: string;
  readonly sponsorPrincipalId: string;
  readonly expiresAt: Date;
  readonly grants: readonly AccessGrant[];
  readonly status: GuestStatus;
}

export type GuestDenialReason = "revoked" | "expired" | "sponsor_inactive" | "sponsor_mismatch";

export class GuestDeniedError extends Error {
  constructor(
    public readonly reason: GuestDenialReason,
    message: string
  ) {
    super(message);
    this.name = "GuestDeniedError";
  }
}

/** Throws unless `guest` is active, unexpired, and its sponsor is authenticatable at `now`. */
export function assertGuestActive(
  guest: Guest,
  sponsor: Pick<Principal, "id" | "businessId" | "status">,
  now: Date = new Date()
): void {
  if (guest.status === "revoked") {
    throw new GuestDeniedError("revoked", `guest ${guest.principalId} has been revoked`);
  }
  if (guest.expiresAt <= now) {
    throw new GuestDeniedError("expired", `guest ${guest.principalId} has expired`);
  }
  if (sponsor.id !== guest.sponsorPrincipalId || sponsor.businessId !== guest.businessId) {
    throw new GuestDeniedError(
      "sponsor_mismatch",
      `sponsor does not match guest ${guest.principalId}'s recorded sponsor`
    );
  }
  if (sponsor.status !== "active") {
    throw new GuestDeniedError(
      "sponsor_inactive",
      `sponsor for guest ${guest.principalId} is not active`
    );
  }
}

/** A guest's own explicit grants only — never the sponsor's. Empty when denied or expired. */
export function guestGrants(
  guest: Guest,
  sponsor: Pick<Principal, "id" | "businessId" | "status">,
  now: Date = new Date()
): readonly AccessGrant[] {
  try {
    assertGuestActive(guest, sponsor, now);
  } catch {
    return [];
  }
  return guest.grants;
}
