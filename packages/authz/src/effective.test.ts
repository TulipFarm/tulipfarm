import { describe, expect, it } from "vitest";
import { type AuthorityLayer, decideEffectivePermission, evaluateGrants } from "./effective";
import type { AccessGrant, AccessRequest } from "./grants";

const NOW = new Date("2026-07-23T12:00:00Z");

const READ: AccessRequest = { action: "record.read", resourceType: "invoice" };
const WRITE: AccessRequest = { action: "record.write", resourceType: "invoice" };

const allowRead: AccessGrant = { action: "record.read", resourceType: "invoice", effect: "allow" };
const allowAll: AccessGrant = { action: "*", resourceType: "*", effect: "allow" };
const denyRead: AccessGrant = { action: "record.read", resourceType: "invoice", effect: "deny" };

function layer(name: string, grants: readonly AccessGrant[]): AuthorityLayer {
  return { name, grants };
}

describe("evaluateGrants", () => {
  it("abstains with no matching grant (default deny at the layer)", () => {
    expect(evaluateGrants([], READ, NOW)).toBe("abstain");
    expect(evaluateGrants([allowRead], WRITE, NOW)).toBe("abstain");
  });

  it("allows on a matching allow", () => {
    expect(evaluateGrants([allowRead], READ, NOW)).toBe("allow");
  });

  it("lets an explicit deny win over any matching allow", () => {
    expect(evaluateGrants([allowAll, denyRead], READ, NOW)).toBe("deny");
    expect(evaluateGrants([denyRead, allowAll], READ, NOW)).toBe("deny");
  });

  it("ignores an expired deny and an expired allow alike", () => {
    const expiredDeny: AccessGrant = { ...denyRead, expiresAt: NOW };
    expect(evaluateGrants([allowRead, expiredDeny], READ, NOW)).toBe("allow");
    const expiredAllow: AccessGrant = { ...allowRead, expiresAt: NOW };
    expect(evaluateGrants([expiredAllow], READ, NOW)).toBe("abstain");
  });
});

describe("decideEffectivePermission", () => {
  it("denies with no layers (fail closed)", () => {
    const decision = decideEffectivePermission([], READ, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no_layers");
  });

  it("allows only when every layer allows", () => {
    const decision = decideEffectivePermission(
      [layer("user", [allowRead]), layer("agent", [allowAll]), layer("credential", [allowRead])],
      READ,
      NOW
    );
    expect(decision).toEqual({ allowed: true, reason: "allowed" });
  });

  it("denies when any layer has no matching allow, naming the layer", () => {
    const decision = decideEffectivePermission(
      [layer("user", [allowRead]), layer("agent", [])],
      READ,
      NOW
    );
    expect(decision).toEqual({
      allowed: false,
      reason: "no_matching_allow",
      deniedLayer: "agent",
    });
  });

  it("lets one layer's explicit deny beat every other layer's allow", () => {
    const decision = decideEffectivePermission(
      [layer("user", [allowAll]), layer("guardrail", [allowAll, denyRead])],
      READ,
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "explicit_deny", deniedLayer: "guardrail" });
  });

  it("never unions: adding a broader layer cannot flip a denial", () => {
    const denied = [layer("user", [allowRead]), layer("agent", [])];
    expect(decideEffectivePermission(denied, READ, NOW).allowed).toBe(false);
    const withBroadTeam = [...denied, layer("team", [allowAll])];
    expect(decideEffectivePermission(withBroadTeam, READ, NOW).allowed).toBe(false);
  });

  it("only narrows for child Runs: child layers can drop but never add authority", () => {
    const parent = [layer("user", [allowAll]), layer("agent", [allowAll])];
    expect(decideEffectivePermission(parent, WRITE, NOW).allowed).toBe(true);

    const child = [...parent, layer("child-contract", [allowRead])];
    expect(decideEffectivePermission(child, READ, NOW).allowed).toBe(true);
    expect(decideEffectivePermission(child, WRITE, NOW).allowed).toBe(false);
  });
});
