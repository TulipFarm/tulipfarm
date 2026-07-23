import { describe, expect, it } from "vitest";
import { InMemorySessionRepo, type SessionRecord } from "./session-repo";

const NOW = new Date("2026-07-23T12:00:00Z");

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: "sid-1",
    principalId: "principal-1",
    businessId: "business-1",
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

describe("InMemorySessionRepo", () => {
  it("round-trips a created session by sid", async () => {
    const repo = new InMemorySessionRepo();
    const stored = record();
    await repo.create(stored);
    await expect(repo.get("business-1", "sid-1", NOW)).resolves.toEqual(stored);
  });

  it("returns undefined once the session has expired", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record({ expiresAt: new Date(NOW.getTime() - 1_000) }));
    await expect(repo.get("business-1", "sid-1", NOW)).resolves.toBeUndefined();
  });

  it("returns undefined after destroy", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record());
    await repo.destroy("business-1", "sid-1");
    await expect(repo.get("business-1", "sid-1", NOW)).resolves.toBeUndefined();
  });

  it("keeps sessions for distinct principals in the same business isolated", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record({ sid: "sid-a", principalId: "principal-a" }));
    await repo.create(record({ sid: "sid-b", principalId: "principal-b" }));
    await expect(repo.get("business-1", "sid-a", NOW)).resolves.toMatchObject({
      principalId: "principal-a",
    });
    await expect(repo.get("business-1", "sid-b", NOW)).resolves.toMatchObject({
      principalId: "principal-b",
    });
  });

  it("isolates the same session id across businesses", async () => {
    const repo = new InMemorySessionRepo();
    await repo.create(record({ businessId: "business-1", principalId: "principal-1" }));
    await repo.create(record({ businessId: "business-2", principalId: "principal-2" }));

    await expect(repo.get("business-1", "sid-1", NOW)).resolves.toMatchObject({
      principalId: "principal-1",
    });
    await expect(repo.get("business-2", "sid-1", NOW)).resolves.toMatchObject({
      principalId: "principal-2",
    });
  });
});
