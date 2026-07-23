import { describe, expect, it } from "vitest";
import { computeEventHash } from "./chain";
import type { AuditEventInput } from "./event";

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

describe("computeEventHash", () => {
  it("is deterministic for identical input", () => {
    const a = computeEventHash(input(), "id-1", "biz-1", 0, null);
    const b = computeEventHash(input(), "id-1", "biz-1", 0, null);
    expect(a).toBe(b);
  });

  it("changes when previousHash changes (chain linkage is covered by the hash)", () => {
    const a = computeEventHash(input(), "id-1", "biz-1", 1, "hash-a");
    const b = computeEventHash(input(), "id-1", "biz-1", 1, "hash-b");
    expect(a).not.toBe(b);
  });

  it("only hashes safeRefs key/hash, never arbitrary payload fields (DLP boundary)", () => {
    const withExtraProps = computeEventHash(
      input({
        safeRefs: [
          { key: "k1", hash: "h1", plaintext: "secret" } as unknown as {
            key: string;
            hash: string;
          },
        ],
      }),
      "id-1",
      "biz-1",
      0,
      null
    );
    const withoutExtraProps = computeEventHash(
      input({ safeRefs: [{ key: "k1", hash: "h1" }] }),
      "id-1",
      "biz-1",
      0,
      null
    );
    expect(withExtraProps).toBe(withoutExtraProps);
  });
});
