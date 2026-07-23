import { describe, expect, it } from "vitest";
import { InMemoryPrincipalRepo, type PrincipalRecord } from "./principal-repo";

function record(overrides: Partial<PrincipalRecord> = {}): PrincipalRecord {
  return {
    id: "principal-1",
    businessId: "business-1",
    kind: "user",
    status: "active",
    ...overrides,
  };
}

describe("InMemoryPrincipalRepo", () => {
  it("round-trips a stored principal by id", async () => {
    const repo = new InMemoryPrincipalRepo();
    await repo.put(record());
    await expect(repo.get("business-1", "principal-1")).resolves.toEqual(record());
  });

  it("returns undefined for an unknown principal", async () => {
    const repo = new InMemoryPrincipalRepo();
    await expect(repo.get("business-1", "missing")).resolves.toBeUndefined();
  });

  it("stores every distinct principal kind with its own business_id", async () => {
    const repo = new InMemoryPrincipalRepo();
    const kinds: PrincipalRecord["kind"][] = [
      "user",
      "agent",
      "routine",
      "integration_adapter",
      "api",
      "service",
    ];
    for (const kind of kinds) {
      await repo.put(record({ id: `p-${kind}`, kind, businessId: "business-9" }));
    }
    for (const kind of kinds) {
      await expect(repo.get("business-9", `p-${kind}`)).resolves.toMatchObject({
        kind,
        businessId: "business-9",
      });
    }
  });

  it("isolates the same principal id across businesses", async () => {
    const repo = new InMemoryPrincipalRepo();
    await repo.put(record({ businessId: "business-1", status: "active" }));
    await repo.put(record({ businessId: "business-2", status: "disabled" }));

    await expect(repo.get("business-1", "principal-1")).resolves.toMatchObject({
      status: "active",
    });
    await expect(repo.get("business-2", "principal-1")).resolves.toMatchObject({
      status: "disabled",
    });
  });
});
