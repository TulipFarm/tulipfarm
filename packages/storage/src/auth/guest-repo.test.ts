import { describe, expect, it } from "vitest";
import { type GuestRecord, InMemoryGuestRepo } from "./guest-repo";

function guest(overrides: Partial<GuestRecord> = {}): GuestRecord {
  return {
    principalId: "guest-1",
    businessId: "business-1",
    sponsorPrincipalId: "sponsor-1",
    expiresAt: new Date("2026-08-01T00:00:00Z"),
    grants: [{ action: "record.read", resourceType: "invoice", effect: "allow" }],
    status: "active",
    ...overrides,
  };
}

describe("InMemoryGuestRepo", () => {
  it("round-trips a guest record and returns undefined for an unknown id", async () => {
    const repo = new InMemoryGuestRepo();
    await repo.put(guest());
    await expect(repo.get("guest-1")).resolves.toEqual(guest());
    await expect(repo.get("missing")).resolves.toBeUndefined();
  });

  it("revokes an existing guest without touching its other fields", async () => {
    const repo = new InMemoryGuestRepo();
    await repo.put(guest());
    await repo.revoke("guest-1");
    await expect(repo.get("guest-1")).resolves.toMatchObject({ status: "revoked" });
  });

  it("revoking an unknown guest is a no-op", async () => {
    const repo = new InMemoryGuestRepo();
    await expect(repo.revoke("missing")).resolves.toBeUndefined();
    await expect(repo.get("missing")).resolves.toBeUndefined();
  });
});
