import { describe, expect, it } from "vitest";
import { assertJitGrantIssuable, JitDeniedError, type JitGrantRequest } from "./jit";

const NOW = new Date("2026-07-23T12:00:00Z");
const FUTURE_GRANT = {
  action: "record.read",
  resourceType: "invoice",
  effect: "allow",
  expiresAt: new Date(NOW.getTime() + 60_000),
} as const;
const APPROVER = {
  id: "approver-1",
  businessId: "business-1",
  status: "active",
} as const;

function request(overrides: Partial<JitGrantRequest> = {}): JitGrantRequest {
  return {
    principalId: "principal-1",
    businessId: "business-1",
    grant: FUTURE_GRANT,
    justification: "one-off incident triage",
    ...overrides,
  };
}

describe("assertJitGrantIssuable", () => {
  it("allows an expiring grant approved by a different in-business approver", () => {
    expect(() => assertJitGrantIssuable(request(), APPROVER, NOW)).not.toThrow();
  });

  it("denies a grant without a future expiry", () => {
    const standing = request({ grant: { ...FUTURE_GRANT, expiresAt: undefined } });
    try {
      assertJitGrantIssuable(standing, APPROVER, NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(JitDeniedError);
      expect((error as JitDeniedError).reason).toBe("missing_expiry");
    }
  });

  it("denies a grant whose expiry has already passed", () => {
    const past = request({ grant: { ...FUTURE_GRANT, expiresAt: new Date(NOW.getTime() - 1) } });
    expect(() => assertJitGrantIssuable(past, APPROVER, NOW)).toThrow(JitDeniedError);
  });

  it("denies an approver from a different business", () => {
    try {
      assertJitGrantIssuable(request(), { ...APPROVER, businessId: "business-2" }, NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(JitDeniedError);
      expect((error as JitDeniedError).reason).toBe("business_mismatch");
    }
  });

  it("denies self-approval", () => {
    try {
      assertJitGrantIssuable(request(), { ...APPROVER, id: "principal-1" }, NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(JitDeniedError);
      expect((error as JitDeniedError).reason).toBe("self_approval");
    }
  });

  it("denies a disabled or expired approver", () => {
    expect(() =>
      assertJitGrantIssuable(request(), { ...APPROVER, status: "disabled" }, NOW)
    ).toThrow(expect.objectContaining({ reason: "approver_inactive" }));
    expect(() =>
      assertJitGrantIssuable(
        request(),
        { ...APPROVER, expiresAt: new Date(NOW.getTime() - 1) },
        NOW
      )
    ).toThrow(expect.objectContaining({ reason: "approver_inactive" }));
  });
});
