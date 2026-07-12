import type { ContentFilterConfig } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { GuardContext } from "../pipeline";
import { makeContentFilterGuard } from "./content-filter";

const ctx: GuardContext = {
  userId: "u1",
  agentId: "a1",
  conversationId: "c1",
  autonomy: "supervised",
};

function cfg(...patterns: ContentFilterConfig["patterns"]): ContentFilterConfig {
  return { guard: "content_filter", patterns };
}

describe("makeContentFilterGuard", () => {
  it("is named content_filter", () => {
    expect(makeContentFilterGuard(cfg("email")).name).toBe("content_filter");
  });

  it("blocks a Luhn-valid credit card number (AC-V1-003)", () => {
    const guard = makeContentFilterGuard(cfg("credit_card"));
    const verdict = guard.run("Charge it to 4111 1111 1111 1111 please.", ctx);
    expect(verdict).toEqual({
      action: "block",
      reason: "content_filter:credit_card",
      message: "The response was blocked by a content guardrail.",
    });
  });

  it("passes a 16-digit Luhn-invalid sequence (no false positive)", () => {
    const guard = makeContentFilterGuard(cfg("credit_card"));
    // 1234 5678 9012 3456 fails the Luhn checksum.
    expect(guard.run("order id 1234 5678 9012 3456", ctx)).toEqual({ action: "pass" });
  });

  it("blocks an SSN when ssn is active", () => {
    const guard = makeContentFilterGuard(cfg("ssn"));
    expect(guard.run("ssn is 123-45-6789 ok", ctx)).toEqual({
      action: "block",
      reason: "content_filter:ssn",
      message: "The response was blocked by a content guardrail.",
    });
  });

  it("blocks an API key when api_key is active", () => {
    const guard = makeContentFilterGuard(cfg("api_key"));
    expect(guard.run("key sk-abcdefghijklmnop1234 here", ctx)).toEqual({
      action: "block",
      reason: "content_filter:api_key",
      message: "The response was blocked by a content guardrail.",
    });
    expect(guard.run("aws AKIAIOSFODNN7EXAMPLE used", ctx)).toEqual({
      action: "block",
      reason: "content_filter:api_key",
      message: "The response was blocked by a content guardrail.",
    });
    expect(guard.run("token ghp_0123456789abcdefghijklmnopqrstuvwxyz here", ctx)).toEqual({
      action: "block",
      reason: "content_filter:api_key",
      message: "The response was blocked by a content guardrail.",
    });
  });

  it("blocks an email when email is active", () => {
    const guard = makeContentFilterGuard(cfg("email"));
    expect(guard.run("reach me at jane.doe@example.com today", ctx)).toEqual({
      action: "block",
      reason: "content_filter:email",
      message: "The response was blocked by a content guardrail.",
    });
  });

  it("does not block content for a pattern not in cfg.patterns", () => {
    // ssn active, but the text only contains an email — must pass.
    const guard = makeContentFilterGuard(cfg("ssn"));
    expect(guard.run("reach me at jane.doe@example.com today", ctx)).toEqual({
      action: "pass",
    });
  });

  it("passes clean prose", () => {
    const guard = makeContentFilterGuard(cfg("credit_card", "ssn", "api_key", "email"));
    expect(guard.run("Tulips bloom best in well-drained soil under full sun.", ctx)).toEqual({
      action: "pass",
    });
  });
});
