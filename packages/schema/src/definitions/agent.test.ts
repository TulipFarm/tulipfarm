import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors";
import { SchemaRegistry } from "../registry";
import { AGENT_DEFINITION } from "./agent";
import { DEFINITION_API_VERSION } from "./common";

function registry(): SchemaRegistry {
  return new SchemaRegistry([AGENT_DEFINITION]);
}

const metadata = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "general-assistant",
  schemaVersion: 1,
  authoredVersion: 3,
  lifecycle: "published",
};

const full = {
  apiVersion: DEFINITION_API_VERSION,
  kind: "Agent",
  metadata: { ...metadata, displayName: "General Assistant", publishedDigest: "a".repeat(64) },
  spec: {
    owner: "user_01",
    maintainers: ["user_02"],
    personality: "Helpful and precise.",
    roles: ["agent-operator"],
    permissionCeiling: { grants: ["read-tickets"], maxRiskClass: "medium" },
    modelProfile: "sol-high",
    skills: ["triage"],
    allowedTools: ["github.issue.get"],
    autonomy: "execute_low_risk",
    limits: { tokens: 100000, costUsd: 1.5, delegationDepth: 2 },
    guardrails: { data: "pii-guardrail", delegation: "delegation-guardrail" },
    memoryScopes: ["agent_private", "business"],
    knowledgeScopes: ["support-space"],
    trustTier: "business_authored",
    evaluationSuite: "triage-evals",
  },
};

const minimal = {
  apiVersion: DEFINITION_API_VERSION,
  kind: "Agent",
  metadata,
  spec: {
    owner: "user_01",
    modelProfile: "sol-high",
    autonomy: "answer_only",
    trustTier: "first_party",
  },
};

describe("Agent definition schema", () => {
  it("registers without violating the strict-object or discriminator contract", () => {
    expect(() => registry()).not.toThrow();
  });

  it("validates a fully populated Agent definition", () => {
    const result = registry().validate(full);
    expect(result).toMatchObject({ apiVersion: DEFINITION_API_VERSION, kind: "Agent" });
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates a minimal Agent with only required spec fields", () => {
    expect(() => registry().validate(minimal)).not.toThrow();
  });

  it("rejects an unknown autonomy ceiling", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, autonomy: "do_anything" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects an unknown lifecycle state", () => {
    const doc = { ...minimal, metadata: { ...metadata, lifecycle: "archived" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects an unknown trust tier", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, trustTier: "vendor" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a missing required spec field", () => {
    const { modelProfile: _drop, ...spec } = minimal.spec;
    expect(() => registry().validate({ ...minimal, spec })).toThrow(SchemaValidationError);
  });

  it("rejects unknown top-level spec properties", () => {
    const doc = { ...minimal, spec: { ...minimal.spec, superuser: true } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a malformed identifier", () => {
    const doc = { ...minimal, metadata: { ...metadata, id: "not-a-ulid-or-uuid" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("rejects a non-kebab slug", () => {
    const doc = { ...minimal, metadata: { ...metadata, slug: "General Assistant" } };
    expect(() => registry().validate(doc)).toThrow(SchemaValidationError);
  });

  it("owns the Agent kind at the canonical api version", () => {
    expect(AGENT_DEFINITION).toMatchObject({ apiVersion: DEFINITION_API_VERSION, kind: "Agent" });
  });
});
