import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { IngressReplyResultSchema } from "./integration-reply";

describe("IngressReplyResultSchema", () => {
  it("does not accept an unclassified failed reply", () => {
    expect(Value.Check(IngressReplyResultSchema, { delivered: false })).toBe(false);
    expect(
      Value.Check(IngressReplyResultSchema, {
        delivered: false,
        outcome: "ambiguous",
        code: "indeterminate",
      })
    ).toBe(true);
  });

  it("preserves the durable wait rather than accepting a success with failure details", () => {
    expect(
      Value.Check(IngressReplyResultSchema, {
        delivered: false,
        outcome: "retryable",
        code: "provider_retry_wait",
        waitId: "wait-1",
      })
    ).toBe(true);
    expect(Value.Check(IngressReplyResultSchema, { delivered: true, outcome: "failed" })).toBe(
      false
    );
  });
});
