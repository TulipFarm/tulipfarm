import { describe, expect, it } from "vitest";
import {
  assertConversationSenderAuthorized,
  assertSessionMatchesPrincipal,
  decideEffectivePermission,
  ExternalIdentityDeniedError,
  guestGrants,
  PrincipalDeniedError,
} from "../../src";
import {
  ALLOW_CASE,
  AUTHORITY_MATRIX,
  EXTERNAL_IDENTITY_MATRIX,
  NOW,
  REVOCATION_CASE,
  SESSION_SUBSTITUTION_MATRIX,
} from "./matrix-fixtures";

describe("authorization isolation matrix", () => {
  it.each([ALLOW_CASE, ...AUTHORITY_MATRIX])("$dimension: $description", (testCase) => {
    const decision = decideEffectivePermission(testCase.layers, testCase.request, NOW);

    expect(decision).toEqual(testCase.expected);
    expect(JSON.stringify(decision)).not.toMatch(
      /record-sensitive|field-sensitive|destination-sensitive|credential-sensitive/
    );
  });

  it.each(
    SESSION_SUBSTITUTION_MATRIX
  )("$dimension: denies $description without identity substitution", ({ principal, session }) => {
    try {
      assertSessionMatchesPrincipal(session, principal, NOW);
      throw new Error("expected session substitution denial");
    } catch (error) {
      expect(error).toBeInstanceOf(PrincipalDeniedError);
      expect((error as PrincipalDeniedError).reason).toBe("substitution");
    }
  });

  it.each(EXTERNAL_IDENTITY_MATRIX)("external identity: denies $description with safe evidence", ({
    mapping,
    expectedReason,
  }) => {
    try {
      assertConversationSenderAuthorized(mapping, "user-owner", "business-a", NOW);
      throw new Error("expected external identity denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalIdentityDeniedError);
      expect((error as ExternalIdentityDeniedError).reason).toBe(expectedReason);
    }
  });

  it("revocation removes delegated guest authority immediately", () => {
    const grants = guestGrants(REVOCATION_CASE.guest, REVOCATION_CASE.sponsor, NOW);
    const decision = decideEffectivePermission(
      [{ name: "revoked_guest", grants }],
      REVOCATION_CASE.request,
      NOW
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "no_matching_allow",
      deniedLayer: "revoked_guest",
    });
  });
});
