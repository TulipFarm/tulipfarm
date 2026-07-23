import { describe, expect, it } from "vitest";
import { InMemoryRecertificationRepo, type RecertificationDueRecord } from "./recertification-repo";

const NOW = new Date("2026-07-23T12:00:00Z");

function due(overrides: Partial<RecertificationDueRecord> = {}): RecertificationDueRecord {
  return {
    principalId: "principal-1",
    businessId: "business-1",
    grantId: "grant-1",
    dueAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

describe("InMemoryRecertificationRepo", () => {
  it("round-trips a record by grant id and returns undefined for an unknown grant", async () => {
    const repo = new InMemoryRecertificationRepo();
    await repo.put(due());
    await expect(repo.get("business-1", "grant-1")).resolves.toEqual(due());
    await expect(repo.get("business-1", "missing")).resolves.toBeUndefined();
  });

  it("lists only records due at or before the given time", async () => {
    const repo = new InMemoryRecertificationRepo();
    await repo.put(due({ grantId: "overdue", dueAt: new Date(NOW.getTime() - 1_000) }));
    await repo.put(due({ grantId: "future", dueAt: new Date(NOW.getTime() + 60_000) }));
    const listed = await repo.listDue("business-1", NOW);
    expect(listed.map((r) => r.grantId)).toEqual(["overdue"]);
  });

  it("isolates due records and duplicate grant ids by business", async () => {
    const repo = new InMemoryRecertificationRepo();
    await repo.put(due({ businessId: "business-1", grantId: "shared", principalId: "p1" }));
    await repo.put(due({ businessId: "business-2", grantId: "shared", principalId: "p2" }));

    await expect(repo.get("business-1", "shared")).resolves.toMatchObject({
      principalId: "p1",
    });
    await expect(repo.get("business-2", "shared")).resolves.toMatchObject({
      principalId: "p2",
    });
  });
});
