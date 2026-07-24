import { describe, expect, it } from "vitest";
import { evaluateStepUp, type MfaVerifier, MfaVerifierRegistry } from "./step-up";

const POLICY = { methods: ["totp", "passkey"] as const, maxAgeSeconds: 300 };

describe("evaluateStepUp", () => {
  it("denies an unauthenticated request", () => {
    expect(evaluateStepUp(undefined, POLICY)).toEqual({
      satisfied: false,
      reason: "unauthenticated",
    });
  });

  it("denies a first-factor-only session", () => {
    expect(evaluateStepUp({ authMethods: ["password"] }, POLICY)).toEqual({
      satisfied: false,
      reason: "step_up_required",
    });
  });

  it("denies when the method is recorded but no verification time is", () => {
    expect(evaluateStepUp({ authMethods: ["password", "totp"] }, POLICY)).toEqual({
      satisfied: false,
      reason: "step_up_required",
    });
  });

  it("accepts a recent second factor", () => {
    const now = new Date();
    const result = evaluateStepUp(
      { authMethods: ["password", "passkey"], mfaVerifiedAt: new Date(now.getTime() - 60_000) },
      POLICY,
      now
    );

    expect(result.satisfied).toBe(true);
  });

  it("denies a stale second factor", () => {
    const now = new Date();
    const result = evaluateStepUp(
      { authMethods: ["password", "totp"], mfaVerifiedAt: new Date(now.getTime() - 301_000) },
      POLICY,
      now
    );

    expect(result).toEqual({ satisfied: false, reason: "step_up_stale" });
  });

  it("denies at the exact boundary + 1s and accepts at the boundary", () => {
    const now = new Date();
    const atBoundary = evaluateStepUp(
      { authMethods: ["totp"], mfaVerifiedAt: new Date(now.getTime() - 300_000) },
      POLICY,
      now
    );
    const pastBoundary = evaluateStepUp(
      { authMethods: ["totp"], mfaVerifiedAt: new Date(now.getTime() - 300_001) },
      POLICY,
      now
    );

    expect(atBoundary.satisfied).toBe(true);
    expect(pastBoundary.satisfied).toBe(false);
  });

  it("denies a session whose second factor is not one the policy accepts", () => {
    const now = new Date();
    const result = evaluateStepUp(
      { authMethods: ["password", "oidc"], mfaVerifiedAt: now },
      POLICY,
      now
    );

    expect(result.reason).toBe("step_up_required");
  });
});

describe("MfaVerifierRegistry", () => {
  it("is empty by default, so no factor is implicitly satisfied", () => {
    const registry = new MfaVerifierRegistry();

    expect(registry.supportedMethods()).toEqual([]);
    expect(registry.get("totp")).toBeUndefined();
  });

  it("returns a registered verifier by method", () => {
    const verifier: MfaVerifier = { method: "passkey", verify: async () => true };
    const registry = new MfaVerifierRegistry([verifier]);

    expect(registry.get("passkey")).toBe(verifier);
    expect(registry.supportedMethods()).toEqual(["passkey"]);
  });
});
