import { describe, expect, it } from "vitest";
import { assertGuestActive, type Guest, GuestDeniedError, guestGrants } from "./guests";
import type { Principal } from "./principals";

const NOW = new Date("2026-07-23T12:00:00Z");
const READ_GRANT = { action: "record.read", resourceType: "invoice", effect: "allow" } as const;

function guest(overrides: Partial<Guest> = {}): Guest {
  return {
    principalId: "guest-1",
    businessId: "business-1",
    sponsorPrincipalId: "sponsor-1",
    expiresAt: new Date(NOW.getTime() + 60_000),
    grants: [READ_GRANT],
    status: "active",
    ...overrides,
  };
}

function sponsor(
  overrides: Partial<Principal> = {}
): Pick<Principal, "id" | "businessId" | "status" | "expiresAt"> {
  return { id: "sponsor-1", businessId: "business-1", status: "active", ...overrides };
}

describe("assertGuestActive", () => {
  it("allows an active guest with a valid, active sponsor", () => {
    expect(() => assertGuestActive(guest(), sponsor(), NOW)).not.toThrow();
  });

  it("denies a revoked guest", () => {
    try {
      assertGuestActive(guest({ status: "revoked" }), sponsor(), NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(GuestDeniedError);
      expect((error as GuestDeniedError).reason).toBe("revoked");
    }
  });

  it("denies a guest past its expiry", () => {
    const expired = guest({ expiresAt: new Date(NOW.getTime() - 1_000) });
    expect(() => assertGuestActive(expired, sponsor(), NOW)).toThrow(GuestDeniedError);
  });

  it("denies when the sponsor does not match the guest's recorded sponsor", () => {
    const wrongSponsor = sponsor({ id: "sponsor-2" });
    try {
      assertGuestActive(guest(), wrongSponsor, NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(GuestDeniedError);
      expect((error as GuestDeniedError).reason).toBe("sponsor_mismatch");
    }
  });

  it("denies when the sponsor is no longer active", () => {
    const disabledSponsor = sponsor({ status: "disabled" });
    try {
      assertGuestActive(guest(), disabledSponsor, NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(GuestDeniedError);
      expect((error as GuestDeniedError).reason).toBe("sponsor_inactive");
    }
  });

  it("denies when an active-status sponsor is past its expiry", () => {
    const expiredSponsor = sponsor({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(() => assertGuestActive(guest(), expiredSponsor, NOW)).toThrow(
      expect.objectContaining({ reason: "sponsor_inactive" })
    );
  });
});

describe("guestGrants", () => {
  it("returns the guest's own grants when active", () => {
    expect(guestGrants(guest(), sponsor(), NOW)).toEqual([READ_GRANT]);
  });

  it("returns no grants for a revoked or expired guest, never the sponsor's authority", () => {
    expect(guestGrants(guest({ status: "revoked" }), sponsor(), NOW)).toEqual([]);
    expect(
      guestGrants(guest({ expiresAt: new Date(NOW.getTime() - 1_000) }), sponsor(), NOW)
    ).toEqual([]);
  });
});
