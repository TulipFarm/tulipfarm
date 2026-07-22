import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors";
import { SchemaRegistry } from "../registry";
import { DEFINITION_API_VERSION } from "./common";
import { MODEL_PROFILE_DEFINITION } from "./model";

function registry(): SchemaRegistry {
  return new SchemaRegistry([MODEL_PROFILE_DEFINITION]);
}

const metadata = {
  id: "44444444-4444-4444-4444-444444444444",
  slug: "sol-high",
  schemaVersion: 1,
  authoredVersion: 1,
  lifecycle: "published",
};

const minimal = {
  apiVersion: DEFINITION_API_VERSION,
  kind: "ModelProfile",
  metadata,
  spec: {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning: "high",
    supports: { tools: true, structuredOutput: true, contextWindowTokens: 400000 },
    allowCaching: false,
  },
};

const full = {
  ...minimal,
  spec: {
    ...minimal.spec,
    capabilityClass: "frontier",
    constraints: {
      maxCostUsd: 5,
      maxTokens: 200000,
      maxLatencyMs: 60000,
      dataRetention: "zero_retention",
      allowTraining: false,
      residency: "eu",
    },
    budgets: { maxCostUsd: 2, maxTokens: 100000 },
    fallbacks: ["sol-xhigh", "fable-high"],
  },
};

describe("ModelProfile definition schema", () => {
  it("registers without violating the strict-object or discriminator contract", () => {
    expect(() => registry()).not.toThrow();
  });

  it("validates a fully populated ModelProfile", () => {
    expect(() => registry().validate(full)).not.toThrow();
  });

  it("validates a minimal ModelProfile with only required fields", () => {
    expect(() => registry().validate(minimal)).not.toThrow();
  });

  it("requires caching intent to be explicit", () => {
    const { allowCaching: _drop, ...spec } = minimal.spec;
    expect(() => registry().validate({ ...minimal, spec })).toThrow(SchemaValidationError);
  });

  it("rejects an unknown reasoning level", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, reasoning: "ultra" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects an unknown data-retention posture", () => {
    const doc = {
      ...minimal,
      spec: { ...minimal.spec, constraints: { dataRetention: "keep_forever" } },
    };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a zero context window", () => {
    const doc = {
      ...minimal,
      spec: {
        ...minimal.spec,
        supports: { tools: true, structuredOutput: true, contextWindowTokens: 0 },
      },
    };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a missing support declaration", () => {
    const { supports: _drop, ...spec } = minimal.spec;
    expect(() => registry().validate({ ...minimal, spec })).toThrow(SchemaValidationError);
  });
});
