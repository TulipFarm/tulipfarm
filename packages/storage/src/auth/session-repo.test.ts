import { describe, expect, it } from "vitest";
import { InMemorySessionRepo, type SessionRecord } from "./session-repo";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: "sid-1",
    principalId: "principal-1",
    businessId: "business-1",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("InMemorySessionRepo", () => {
  it("round-trips a created session by sid", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record());
    await expect(repo.get("sid-1")).resolves.toEqual(record());
  });

  it("returns undefined once the session has expired", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record({ expiresAt: new Date(Date.now() - 1_000) }));
    await expect(repo.get("sid-1")).resolves.toBeUndefined();
  });

  it("returns undefined after destroy", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record());
    await repo.destroy("sid-1");
    await expect(repo.get("sid-1")).resolves.toBeUndefined();
  });

  it("keeps sessions for distinct principals in the same business isolated", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record({ sid: "sid-a", principalId: "principal-a" }));
    await repo.create(record({ sid: "sid-b", principalId: "principal-b" }));
    await expect(repo.get("sid-a")).resolves.toMatchObject({ principalId: "principal-a" });
    await expect(repo.get("sid-b")).resolves.toMatchObject({ principalId: "principal-b" });
  });
});
