import { describe, expect, it } from "vitest";
import { type ApprovalBindingInput, bindingsMatch, computeApprovalBinding } from "./binding";

function input(overrides: Partial<ApprovalBindingInput> = {}): ApprovalBindingInput {
  return {
    intent: {
      toolId: "crm.contact",
      toolVersion: "2.1.0",
      action: "contact.update",
      targetRefs: [{ type: "contact", id: "c-1" }],
      arguments: { email: "a@example.com", tier: "gold" },
      destination: "crm.example.com",
      credentialRef: "secret://crm/writer",
    },
    evidenceHashes: ["e1", "e2"],
    guardrailRevision: "gr-17",
    ...overrides,
  };
}

describe("computeApprovalBinding", () => {
  it("is deterministic and independent of argument key order", () => {
    const a = computeApprovalBinding(input());
    const b = computeApprovalBinding(
      input({
        intent: { ...input().intent, arguments: { tier: "gold", email: "a@example.com" } },
      })
    );
    expect(a).toEqual(b);
  });

  it("orders evidence hashes so the evidence digest is set-based", () => {
    const a = computeApprovalBinding(input({ evidenceHashes: ["e1", "e2"] }));
    const b = computeApprovalBinding(input({ evidenceHashes: ["e2", "e1"] }));
    expect(a.evidenceDigest).toBe(b.evidenceDigest);
  });

  it("carries the Guardrail revision verbatim", () => {
    expect(computeApprovalBinding(input()).guardrailRevision).toBe("gr-17");
  });

  it.each([
    ["arguments", { arguments: { email: "b@example.com", tier: "gold" } }],
    ["toolVersion", { toolVersion: "2.1.1" }],
    ["action", { action: "contact.delete" }],
    ["targetRefs", { targetRefs: [{ type: "contact", id: "c-2" }] }],
    [
      "target order",
      {
        targetRefs: [
          { type: "contact", id: "c-1" },
          { type: "contact", id: "c-0" },
        ],
      },
    ],
    ["destination", { destination: "other.example.com" }],
    ["credentialRef", { credentialRef: "secret://crm/admin" }],
  ])("changes the intent digest when %s changes", (_label, patch) => {
    const base = computeApprovalBinding(input());
    const changed = computeApprovalBinding(
      input({ intent: { ...input().intent, ...(patch as object) } })
    );
    expect(changed.intentDigest).not.toBe(base.intentDigest);
  });

  it("changes the evidence digest when evidence changes", () => {
    expect(computeApprovalBinding(input({ evidenceHashes: ["e1", "e3"] })).evidenceDigest).not.toBe(
      computeApprovalBinding(input()).evidenceDigest
    );
  });

  it("distinguishes an absent optional field from a present one", () => {
    const withoutDestination = { ...input().intent };
    delete (withoutDestination as { destination?: string }).destination;
    expect(computeApprovalBinding(input({ intent: withoutDestination })).intentDigest).not.toBe(
      computeApprovalBinding(input()).intentDigest
    );
  });

  it("rejects non-canonicalizable arguments instead of hashing a lossy form", () => {
    expect(() =>
      computeApprovalBinding(
        input({ intent: { ...input().intent, arguments: { at: new Date() } } })
      )
    ).toThrow();
  });

  it("never embeds argument values in the digest output", () => {
    const binding = computeApprovalBinding(input());
    expect(JSON.stringify(binding)).not.toContain("a@example.com");
    expect(JSON.stringify(binding)).not.toContain("secret://crm/writer");
  });
});

describe("bindingsMatch", () => {
  it("matches identical bindings", () => {
    expect(bindingsMatch(computeApprovalBinding(input()), computeApprovalBinding(input()))).toBe(
      true
    );
  });

  it.each([
    ["intent", { intent: { ...input().intent, action: "contact.delete" } }],
    ["evidence", { evidenceHashes: ["e9"] }],
    ["guardrail revision", { guardrailRevision: "gr-18" }],
  ])("rejects a binding whose %s differs", (_label, patch) => {
    expect(
      bindingsMatch(
        computeApprovalBinding(input()),
        computeApprovalBinding(input(patch as Partial<ApprovalBindingInput>))
      )
    ).toBe(false);
  });
});
