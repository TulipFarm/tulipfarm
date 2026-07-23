import { describe, expect, it } from "vitest";
import { InMemoryJitGrantRepo, type JitGrantIssuanceRecord } from "./jit-repo";

const NOW = new Date("2026-07-23T12:00:00Z");

function issuance(overrides: Partial<JitGrantIssuanceRecord> = {}): JitGrantIssuanceRecord {
  return {
    id: "jit-1",
    principalId: "principal-1",
    businessId: "business-1",
    grant: {
      action: "record.read",
      resourceType: "invoice",
      effect: "allow",
      expiresAt: new Date(NOW.getTime() + 60_000),
    },
    approverPrincipalId: "approver-1",
    justification: "incident triage",
    issuedAt: NOW,
    ...overrides,
  };
}

describe("InMemoryJitGrantRepo", () => {
  it("lists active grants for a principal", async () => {
    const repo = new InMemoryJitGrantRepo();
    await repo.put(issuance());
    await repo.put(issuance({ id: "jit-2", principalId: "principal-2" }));
    const active = await repo.listActive("principal-1", NOW);
    expect(active.map((r) => r.id)).toEqual(["jit-1"]);
  });

  it("never lists an expired grant", async () => {
    const repo = new InMemoryJitGrantRepo();
    await repo.put(
      issuance({ grant: { ...issuance().grant, expiresAt: new Date(NOW.getTime() - 1_000) } })
    );
    expect(await repo.listActive("principal-1", NOW)).toEqual([]);
  });
});
