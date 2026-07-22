import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors";
import { SchemaRegistry } from "../registry";
import { DEFINITION_API_VERSION } from "./common";
import { TOOL_CONTRACT_DEFINITION } from "./tool";

function registry(): SchemaRegistry {
  return new SchemaRegistry([TOOL_CONTRACT_DEFINITION]);
}

const metadata = {
  id: "33333333-3333-3333-3333-333333333333",
  slug: "github-issue-label",
  schemaVersion: 1,
  authoredVersion: 2,
  lifecycle: "active",
};

const minimal = {
  apiVersion: DEFINITION_API_VERSION,
  kind: "ToolContract",
  metadata,
  spec: {
    toolId: "github.issue.label",
    toolVersion: "1.0.0",
    action: "label",
    inputSchema: { type: "object", properties: { issue: { type: "number" } } },
    outputSchema: { type: "object" },
    riskClass: "medium",
    mutating: true,
    dryRun: true,
    idempotency: { strategy: "provider" },
    adapter: { kind: "integration", ref: "github" },
  },
};

const full = {
  ...minimal,
  spec: {
    ...minimal.spec,
    errorSchema: { type: "object" },
    requiredActions: ["issues:write"],
    requiredResources: ["ticket"],
    dataClasses: ["internal"],
    allowedDestinations: ["github.com"],
    timeout: { activeMs: 5000, wallClockMs: 30000 },
    retry: { maxAttempts: 3, safeToRetry: false },
    compensation: { operation: "github.issue.unlabel", reconciliation: "github.issue.get" },
  },
};

describe("ToolContract definition schema", () => {
  it("registers without violating the strict-object or discriminator contract", () => {
    expect(() => registry()).not.toThrow();
  });

  it("validates a fully populated ToolContract", () => {
    expect(() => registry().validate(full)).not.toThrow();
  });

  it("validates a minimal ToolContract with only required fields", () => {
    expect(() => registry().validate(minimal)).not.toThrow();
  });

  it("carries an embedded input schema as opaque data", () => {
    const doc = {
      ...minimal,
      spec: {
        ...minimal.spec,
        inputSchema: { type: "object", additionalProperties: false, required: ["x"] },
      },
    };
    expect(() => registry().validate(doc)).not.toThrow();
  });

  it("rejects an unknown risk class", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, riskClass: "catastrophic" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a missing idempotency strategy", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, idempotency: {} } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a partial retry policy", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, retry: { maxAttempts: 1 } } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects an unknown adapter kind", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, adapter: { kind: "ssh", ref: "box" } } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a non-boolean mutating classification", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, mutating: "yes" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });
});
