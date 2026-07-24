import { canonicalHash } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { TypedOutputError, TypedOutputValidator } from "./outputs";

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "confidence"],
  properties: {
    label: { type: "string", enum: ["billing", "support"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

function validator(): TypedOutputValidator {
  return new TypedOutputValidator([{ ref: "classify/output/v1", schema: CLASSIFY_SCHEMA }]);
}

describe("TypedOutputValidator", () => {
  it("returns validated content with a canonical hash", () => {
    const output = validator().validate("classify/output/v1", {
      confidence: 0.9,
      label: "billing",
    });

    expect(output).toEqual({
      schemaRef: "classify/output/v1",
      content: { confidence: 0.9, label: "billing" },
      contentHash: canonicalHash({ label: "billing", confidence: 0.9 }),
    });
  });

  it("hashes independently of key order so equal outputs deduplicate", () => {
    const first = validator().validate("classify/output/v1", { confidence: 1, label: "support" });
    const second = validator().validate("classify/output/v1", { label: "support", confidence: 1 });

    expect(first.contentHash).toBe(second.contentHash);
  });

  it("rejects output that violates the declared schema", () => {
    expect(() =>
      validator().validate("classify/output/v1", { label: "other", confidence: 0.5 })
    ).toThrow(TypedOutputError);
  });

  it("rejects an unknown schema reference instead of passing output through", () => {
    try {
      validator().validate("classify/output/v2", { label: "billing", confidence: 0.5 });
      expect.unreachable("unknown schema must be rejected");
    } catch (error) {
      expect((error as TypedOutputError).code).toBe("unknown_output_schema");
    }
  });

  it("rejects non-object output", () => {
    try {
      validator().validate("classify/output/v1", ["billing"]);
      expect.unreachable("non-object output must be rejected");
    } catch (error) {
      expect((error as TypedOutputError).code).toBe("output_not_object");
    }
  });

  it("never puts the rejected payload into the error message", () => {
    try {
      validator().validate("classify/output/v1", {
        label: "billing",
        confidence: 0.5,
        secret: "sk-live-should-never-be-logged",
      });
      expect.unreachable("additional properties must be rejected");
    } catch (error) {
      const failure = error as TypedOutputError;
      expect(failure.code).toBe("output_schema_invalid");
      expect(failure.message).not.toContain("sk-live-should-never-be-logged");
      expect(failure.message).toContain("classify/output/v1");
    }
  });

  it("rejects a duplicate schema registration", () => {
    expect(
      () =>
        new TypedOutputValidator([
          { ref: "classify/output/v1", schema: CLASSIFY_SCHEMA },
          { ref: "classify/output/v1", schema: CLASSIFY_SCHEMA },
        ])
    ).toThrow(TypedOutputError);
  });

  it("rejects an uncompilable schema at registration", () => {
    expect(
      () => new TypedOutputValidator([{ ref: "broken/v1", schema: { type: "not-a-type" } }])
    ).toThrow(TypedOutputError);
  });
});
