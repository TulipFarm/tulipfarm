import { describe, expect, it } from "vitest";
import { type AuditEventInput, AuditInputError } from "./event";
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
    const other = await writer.append(
      input({
        actor: { principalId: "u2", businessId: "biz-2" },
        effectivePrincipal: { principalId: "u2", businessId: "biz-2" },
      })
    );

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

  it("rejects cross-business actor substitution", async () => {
    const writer = new AuditWriter(new InMemoryAuditEventRepo());

    await expect(
      writer.append(
        input({
          effectivePrincipal: { principalId: "other", businessId: "biz-2" },
        })
      )
    ).rejects.toMatchObject({ code: "BUSINESS_MISMATCH" });
  });

  it("rejects extra and nested protected payloads before persistence", async () => {
    const repo = new InMemoryAuditEventRepo();
    const writer = new AuditWriter(repo);
    const extraPayload = { ...input(), payload: "private body" } as AuditEventInput;

    await expect(writer.append(extraPayload)).rejects.toBeInstanceOf(AuditInputError);
    await expect(
      writer.append(input({ safeMetadata: { password: "hunter2" } }))
    ).rejects.toMatchObject({ code: "PROTECTED_PAYLOAD" });
    await expect(repo.listChain("biz-1")).resolves.toEqual([]);
  });

  it("retries compare-and-append conflicts without forking the chain", async () => {
    const repo = new InMemoryAuditEventRepo();
    const writer = new AuditWriter(repo);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writer.append(input({ action: `record.concurrent-${index}` }))
      )
    );

    const chain = await repo.listChain("biz-1");
    expect(chain).toHaveLength(8);
    expect(verifyChain(chain)).toEqual({ valid: true, issues: [] });
  });

  it("does not expose mutable stored timestamps through repository reads", async () => {
    const repo = new InMemoryAuditEventRepo();
    const writer = new AuditWriter(repo);
    await writer.append(input());

    const exposed = await repo.getLatest("biz-1");
    exposed?.occurredAt.setUTCFullYear(2030);

    const stored = await repo.listChain("biz-1");
    expect(stored[0].occurredAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(verifyChain(stored)).toEqual({ valid: true, issues: [] });
  });
});
