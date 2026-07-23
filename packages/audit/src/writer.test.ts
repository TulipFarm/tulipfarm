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

describe("AuditWriter.append", () => {
  it("appends the first event with no previous hash and chainIndex 0", async () => {
    const repo = new InMemoryAuditEventRepo();
    const writer = new AuditWriter(repo);

    const event = await writer.append(input());

    expect(event.chainIndex).toBe(0);
    expect(event.previousHash).toBeNull();
    expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("links each event's previousHash to the prior event's hash", async () => {
    const repo = new InMemoryAuditEventRepo();
    const writer = new AuditWriter(repo);

    const first = await writer.append(input());
    const second = await writer.append(input({ action: "record.update" }));

    expect(second.chainIndex).toBe(1);
    expect(second.previousHash).toBe(first.hash);
  });

  it("scopes chains per business_id", async () => {
    const repo = new InMemoryAuditEventRepo();
    const writer = new AuditWriter(repo);

    await writer.append(input({ actor: { principalId: "u1", businessId: "biz-1" } }));
    const other = await writer.append(input({ actor: { principalId: "u2", businessId: "biz-2" } }));

    expect(other.chainIndex).toBe(0);
    expect(other.previousHash).toBeNull();
  });

  it("produces a chain that verifies clean end to end", async () => {
    const repo = new InMemoryAuditEventRepo();
    const writer = new AuditWriter(repo);

    await writer.append(input());
    await writer.append(input({ action: "record.update", decision: "deny" }));
    await writer.append(input({ action: "record.delete" }));

    const chain = await repo.listChain("biz-1");
    expect(verifyChain(chain)).toEqual({ valid: true, issues: [] });
  });
});
