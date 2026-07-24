import { describe, expect, it } from "vitest";
import { type ApprovalBindingInput, computeApprovalBinding } from "./binding";
import {
  type ApprovalApprover,
  ApprovalDeniedError,
  type ApprovalRecord,
  assertApprovalUsable,
  assertApproverEligible,
  requiredApproverCount,
} from "./decision";

const BASE_INPUT: ApprovalBindingInput = {
  intent: {
    toolId: "billing.refund",
    toolVersion: "1.0.0",
    action: "refund.issue",
    targetRefs: [{ type: "invoice", id: "inv-1" }],
    arguments: { amount: 500 },
  },
  evidenceHashes: ["ev-1"],
  guardrailRevision: "gr-3",
};

const BINDING = computeApprovalBinding(BASE_INPUT);
const NOW = new Date("2026-07-24T12:00:00.000Z");

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: "ap-1",
    businessId: "biz-1",
    binding: BINDING,
    risk: "high",
    allowedApproverRoles: ["finance_approver"],
    proposerPrincipalId: "user-proposer",
    performerPrincipalId: "user-performer",
    agentPrincipalId: "agent-1",
    expiresAt: new Date("2026-07-24T13:00:00.000Z"),
    decisions: [],
    ...overrides,
  };
}

function approver(overrides: Partial<ApprovalApprover> = {}): ApprovalApprover {
  return {
    principalId: "user-approver-1",
    businessId: "biz-1",
    roles: ["finance_approver"],
    ...overrides,
  };
}

function approved(principalId: string) {
  return {
    approverPrincipalId: principalId,
    approverRoles: ["finance_approver"],
    outcome: "approved" as const,
    decidedAt: NOW,
  };
}

function denialReason(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalDeniedError);
    return (error as ApprovalDeniedError).reason;
  }
  throw new Error("expected the Approval to be denied");
}

describe("requiredApproverCount", () => {
  it("requires four-eyes for high risk by default", () => {
    expect(requiredApproverCount("high")).toBe(2);
  });

  it("requires a single approver below high risk", () => {
    expect(requiredApproverCount("low")).toBe(1);
    expect(requiredApproverCount("medium")).toBe(1);
  });
});

describe("assertApproverEligible", () => {
  it("accepts a qualified approver from the same business", () => {
    expect(() => assertApproverEligible(record(), approver(), NOW)).not.toThrow();
  });

  it.each([
    ["proposer", "user-proposer"],
    ["performer", "user-performer"],
    ["executing Agent", "agent-1"],
  ])("denies self-approval by the %s", (_label, principalId) => {
    expect(
      denialReason(() => assertApproverEligible(record(), approver({ principalId }), NOW))
    ).toBe("self_approval");
  });

  it("denies an approver holding none of the allowed roles", () => {
    expect(
      denialReason(() => assertApproverEligible(record(), approver({ roles: ["viewer"] }), NOW))
    ).toBe("approver_not_qualified");
  });

  it("denies an approver with no roles at all", () => {
    expect(denialReason(() => assertApproverEligible(record(), approver({ roles: [] }), NOW))).toBe(
      "approver_not_qualified"
    );
  });

  it("denies an approver from another business", () => {
    expect(
      denialReason(() => assertApproverEligible(record(), approver({ businessId: "biz-2" }), NOW))
    ).toBe("business_mismatch");
  });

  it("denies a second decision from the same approver", () => {
    expect(
      denialReason(() =>
        assertApproverEligible(
          record({ decisions: [approved("user-approver-1")] }),
          approver(),
          NOW
        )
      )
    ).toBe("duplicate_approver");
  });

  it("denies deciding an expired Approval", () => {
    expect(
      denialReason(() =>
        assertApproverEligible(record(), approver(), new Date("2026-07-24T13:00:00.000Z"))
      )
    ).toBe("expired");
  });

  it("denies deciding a consumed Approval", () => {
    expect(
      denialReason(() => assertApproverEligible(record({ consumedAt: NOW }), approver(), NOW))
    ).toBe("already_used");
  });

  it("denies deciding a revoked Approval", () => {
    expect(
      denialReason(() => assertApproverEligible(record({ revokedAt: NOW }), approver(), NOW))
    ).toBe("revoked");
  });
});

describe("assertApprovalUsable", () => {
  const satisfied = record({
    decisions: [approved("user-approver-1"), approved("user-approver-2")],
  });

  it("accepts a satisfied, unexpired, unused Approval for its exact binding", () => {
    expect(() => assertApprovalUsable(satisfied, BINDING, NOW)).not.toThrow();
  });

  it.each([
    ["arguments", { intent: { ...BASE_INPUT.intent, arguments: { amount: 5000 } } }],
    ["Tool version", { intent: { ...BASE_INPUT.intent, toolVersion: "1.0.1" } }],
    [
      "target Record",
      { intent: { ...BASE_INPUT.intent, targetRefs: [{ type: "invoice", id: "inv-2" }] } },
    ],
    ["destination", { intent: { ...BASE_INPUT.intent, destination: "elsewhere" } }],
    ["Credential scope", { intent: { ...BASE_INPUT.intent, credentialRef: "secret://admin" } }],
    ["evidence", { evidenceHashes: ["ev-2"] }],
    ["Guardrail revision", { guardrailRevision: "gr-4" }],
  ])("denies substitution when the %s changed", (_label, patch) => {
    const substituted = computeApprovalBinding({ ...BASE_INPUT, ...(patch as object) });
    expect(denialReason(() => assertApprovalUsable(satisfied, substituted, NOW))).toBe(
      "binding_mismatch"
    );
  });

  it("denies when fewer than four eyes approved a high-risk action", () => {
    expect(
      denialReason(() =>
        assertApprovalUsable(record({ decisions: [approved("user-approver-1")] }), BINDING, NOW)
      )
    ).toBe("insufficient_approvals");
  });

  it("accepts a single approver below high risk", () => {
    expect(() =>
      assertApprovalUsable(
        record({ risk: "medium", decisions: [approved("user-approver-1")] }),
        BINDING,
        NOW
      )
    ).not.toThrow();
  });

  it("denies when no decision was recorded at all", () => {
    expect(denialReason(() => assertApprovalUsable(record(), BINDING, NOW))).toBe(
      "insufficient_approvals"
    );
  });

  it("lets an explicit denial win over sufficient approvals", () => {
    expect(
      denialReason(() =>
        assertApprovalUsable(
          record({
            decisions: [
              approved("user-approver-1"),
              approved("user-approver-2"),
              {
                approverPrincipalId: "user-approver-3",
                approverRoles: ["finance_approver"],
                outcome: "denied",
                decidedAt: NOW,
              },
            ],
          }),
          BINDING,
          NOW
        )
      )
    ).toBe("denied");
  });

  it("denies an expired Approval at its expiry instant", () => {
    expect(
      denialReason(() =>
        assertApprovalUsable(satisfied, BINDING, new Date("2026-07-24T13:00:00.000Z"))
      )
    ).toBe("expired");
  });

  it("denies replay of a one-use Approval", () => {
    expect(
      denialReason(() => assertApprovalUsable({ ...satisfied, consumedAt: NOW }, BINDING, NOW))
    ).toBe("already_used");
  });

  it("denies a revoked Approval", () => {
    expect(
      denialReason(() => assertApprovalUsable({ ...satisfied, revokedAt: NOW }, BINDING, NOW))
    ).toBe("revoked");
  });

  it("keeps denial evidence free of intent payloads", () => {
    const substituted = computeApprovalBinding({
      ...BASE_INPUT,
      intent: { ...BASE_INPUT.intent, arguments: { amount: 5000, iban: "DE00 1234" } },
    });
    try {
      assertApprovalUsable(satisfied, substituted, NOW);
    } catch (error) {
      expect((error as Error).message).not.toContain("DE00 1234");
      expect((error as Error).message).not.toContain("5000");
    }
  });
});
