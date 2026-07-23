import { describe, expect, it } from "vitest";
import {
  assertConversationSenderAuthorized,
  assertExternalIdentityMapped,
  ExternalIdentityDeniedError,
  type ExternalIdentityMapping,
} from "./external-identities";

const NOW = new Date("2026-07-23T12:00:00Z");

function mapping(overrides: Partial<ExternalIdentityMapping> = {}): ExternalIdentityMapping {
  return {
    businessId: "business-1",
    provider: "slack",
    externalSubject: "U123",
    principalId: "principal-1",
    verifiedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("assertExternalIdentityMapped", () => {
  it("allows a live, business-scoped mapping", () => {
    expect(() => assertExternalIdentityMapped(mapping(), "business-1", NOW)).not.toThrow();
  });

  it("denies an unmapped sender", () => {
    try {
      assertExternalIdentityMapped(undefined, "business-1", NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalIdentityDeniedError);
      expect((error as ExternalIdentityDeniedError).reason).toBe("unmapped");
    }
  });

  it("denies a cross-business mapping", () => {
    const other = mapping({ businessId: "business-2" });
    expect(() => assertExternalIdentityMapped(other, "business-1", NOW)).toThrow(
      ExternalIdentityDeniedError
    );
  });

  it("denies an expired mapping", () => {
    const expired = mapping({ expiresAt: new Date(NOW.getTime() - 1_000) });
    expect(() => assertExternalIdentityMapped(expired, "business-1", NOW)).toThrow(
      ExternalIdentityDeniedError
    );
  });
});

describe("assertConversationSenderAuthorized — Conversation-owner substitution fixture", () => {
  it("allows the mapped owner to act as themselves", () => {
    expect(() =>
      assertConversationSenderAuthorized(mapping(), "principal-1", "business-1", NOW)
    ).not.toThrow();
  });

  it("denies an unmapped external sender chiming into another principal's conversation", () => {
    try {
      assertConversationSenderAuthorized(undefined, "principal-1", "business-1", NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalIdentityDeniedError);
      expect((error as ExternalIdentityDeniedError).reason).toBe("unmapped");
    }
  });

  it("denies a mapped sender who is not the conversation owner (substitution)", () => {
    const otherSender = mapping({ externalSubject: "U999", principalId: "principal-2" });
    try {
      assertConversationSenderAuthorized(otherSender, "principal-1", "business-1", NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalIdentityDeniedError);
      expect((error as ExternalIdentityDeniedError).reason).toBe("substitution");
    }
  });
});
