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
    await expect(repo.get("business-1", "guest-1")).resolves.toEqual(guest());
    await expect(repo.get("business-1", "missing")).resolves.toBeUndefined();
  });

  it("revokes an existing guest without touching its other fields", async () => {
    const repo = new InMemoryGuestRepo();
    await repo.put(guest());
    await repo.revoke("business-1", "guest-1");
    await expect(repo.get("business-1", "guest-1")).resolves.toMatchObject({
      status: "revoked",
    });
  });

  it("revoking an unknown guest is a no-op", async () => {
    const repo = new InMemoryGuestRepo();
    await expect(repo.revoke("business-1", "missing")).resolves.toBeUndefined();
    await expect(repo.get("business-1", "missing")).resolves.toBeUndefined();
  });

  it("isolates the same guest principal id across businesses", async () => {
    const repo = new InMemoryGuestRepo();
    await repo.put(guest({ businessId: "business-1", sponsorPrincipalId: "sponsor-1" }));
    await repo.put(guest({ businessId: "business-2", sponsorPrincipalId: "sponsor-2" }));

    await expect(repo.get("business-1", "guest-1")).resolves.toMatchObject({
      sponsorPrincipalId: "sponsor-1",
    });
    await expect(repo.get("business-2", "guest-1")).resolves.toMatchObject({
      sponsorPrincipalId: "sponsor-2",
    });
  });
});
