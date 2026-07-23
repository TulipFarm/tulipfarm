import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "./event";
import { InMemoryAuditEventRepo } from "./storage";
import { verifyChain } from "./verify";
import { AuditWriter } from "./writer";

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor: { principalId: "user-1", businessId: "biz-1" },
    effectivePrincipal: { principalId: "user-1", businessId: "biz-1" },
    action: "record.read",
    target: "resource:invoice/1",
    decision: "allow",
    reasonCodes: [],
    correlationId: "corr-1",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function buildChain(n: number) {
  const repo = new InMemoryAuditEventRepo();
  const writer = new AuditWriter(repo);
  for (let i = 0; i < n; i += 1) {
    await writer.append(input({ action: `action.${i}` }));
  }
  return repo.listChain("biz-1");
}

describe("verifyChain", () => {
  it("passes an untouched chain", async () => {
    const chain = await buildChain(3);
    expect(verifyChain(chain)).toEqual({ valid: true, issues: [] });
  });

  it("passes an empty chain", () => {
    expect(verifyChain([])).toEqual({ valid: true, issues: [] });
  });

  it("detects a tampered payload (recorded hash no longer matches recomputed hash)", async () => {
    const chain = await buildChain(3);
    const tampered = [...chain];
    tampered[1] = { ...tampered[1], target: "resource:invoice/999" };

    const result = verifyChain(tampered);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      type: "tampered",
      chainIndex: 1,
      eventIds: [chain[1].id],
    });
  });

  it("detects a deleted segment (chainIndex gap)", async () => {
    const chain = await buildChain(3);
    const withDeletion = [chain[0], chain[2]];

    const result = verifyChain(withDeletion);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ type: "missing", chainIndex: 1, eventIds: [] });
  });

  it("detects a forked chain (two events at the same chainIndex)", async () => {
    const chain = await buildChain(2);
    const forkedEvent = { ...chain[1], id: "forked-event", target: "resource:invoice/fork" };

    const result = verifyChain([...chain, forkedEvent]);

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.type === "forked" && issue.chainIndex === 1)).toBe(
      true
    );
  });

  it("detects a reordered previousHash link", async () => {
    const chain = await buildChain(3);
    const reordered = [...chain];
    reordered[2] = { ...reordered[2], previousHash: chain[0].hash };

    const result = verifyChain(reordered);

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.type === "reordered" && issue.chainIndex === 2)
    ).toBe(true);
  });
});
