import { describe, expect, it } from "vitest";
import {
  assertPrincipalAuthenticatable,
  assertSessionMatchesPrincipal,
  type Principal,
  PrincipalDeniedError,
  type SessionBinding,
} from "./principals";

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: "principal-1",
    businessId: "business-1",
    kind: "user",
    status: "active",
    ...overrides,
  };
}

function session(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    sid: "sid-1",
    principalId: "principal-1",
    businessId: "business-1",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("assertPrincipalAuthenticatable", () => {
  it("allows an active, unexpired principal of every kind", () => {
    const kinds: Principal["kind"][] = [
      "user",
      "agent",
      "routine",
      "integration_adapter",
      "api",
      "service",
    ];
    for (const kind of kinds) {
      expect(() => assertPrincipalAuthenticatable(principal({ kind }))).not.toThrow();
    }
  });

  it("denies a disabled principal", () => {
    expect(() => assertPrincipalAuthenticatable(principal({ status: "disabled" }))).toThrow(
      PrincipalDeniedError
    );
  });

  it("denies a principal past its expiry", () => {
    const expired = principal({ expiresAt: new Date(Date.now() - 1_000) });
    expect(() => assertPrincipalAuthenticatable(expired)).toThrow(PrincipalDeniedError);
  });

  it("carries a deterministic reason code per denial cause", () => {
    try {
      assertPrincipalAuthenticatable(principal({ status: "expired" }));
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(PrincipalDeniedError);
      expect((error as PrincipalDeniedError).reason).toBe("expired");
    }
  });
});

describe("assertSessionMatchesPrincipal", () => {
  it("allows a session bound to its own principal and business", () => {
    expect(() => assertSessionMatchesPrincipal(session(), principal())).not.toThrow();
  });

  it("denies substitution across a business boundary", () => {
    const other = principal({ businessId: "business-2" });
    expect(() => assertSessionMatchesPrincipal(session(), other)).toThrow(PrincipalDeniedError);
  });

  it("denies substitution with a different principal in the same business", () => {
    const other = principal({ id: "principal-2" });
    expect(() => assertSessionMatchesPrincipal(session(), other)).toThrow(PrincipalDeniedError);
  });

  it("denies an expired session even for the correct principal", () => {
    const expiredSession = session({ expiresAt: new Date(Date.now() - 1_000) });
    expect(() => assertSessionMatchesPrincipal(expiredSession, principal())).toThrow(
      PrincipalDeniedError
    );
  });
});
