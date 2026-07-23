import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  type SoulSemanticIssueCode,
  SoulSemanticValidationError,
  validateSoulSemantics,
} from "./index";

const API = "tulipfarm.ai/v1";

function def(
  kind: string,
  slug: string,
  spec: Record<string, unknown>,
  extra: { id?: string; authoredVersion?: number } = {}
): VersionedSchemaDocument {
  return {
    apiVersion: API,
    kind,
    metadata: {
      id: extra.id ?? `id-${kind}-${slug}`,
      slug,
      schemaVersion: 1,
      authoredVersion: extra.authoredVersion ?? 1,
      lifecycle: "draft",
    },
    spec,
  } as unknown as VersionedSchemaDocument;
}

function model(slug: string, spec: Record<string, unknown> = {}): VersionedSchemaDocument {
  return def("ModelProfile", slug, {
    provider: "p",
    model: "m",
    reasoning: "low",
    supports: { tools: true, structuredOutput: true, contextWindowTokens: 1 },
    allowCaching: false,
    ...spec,
  });
}

function tool(slug: string, spec: Record<string, unknown> = {}): VersionedSchemaDocument {
  return def("ToolContract", slug, {
    toolId: slug,
    toolVersion: "1",
    action: "do",
    inputSchema: {},
    outputSchema: {},
    riskClass: "low",
    mutating: false,
    dryRun: true,
    idempotency: { strategy: "none" },
    adapter: { kind: "native", ref: "x" },
    ...spec,
  });
}

/** Catch and return the thrown error's issue codes, or fail if nothing was thrown. */
function codes(fn: () => void): SoulSemanticIssueCode[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof SoulSemanticValidationError) return err.issues.map((i) => i.code);
    throw err;
  }
  throw new Error("expected SoulSemanticValidationError");
}

describe("validateSoulSemantics", () => {
  it("accepts a coherent tree", () => {
    const docs = [
      model("fast"),
      tool("send", { allowedDestinations: ["slack"] }),
      def("Agent", "helper", {
        owner: "u",
        instructions: { path: "instructions.md" },
        modelProfile: "fast",
        allowedTools: ["send"],
        autonomy: "answer_only",
        trustTier: "first_party",
        permissionCeiling: { maxRiskClass: "high" },
      }),
      def("Routine", "flow", {
        owner: "u",
        start: "First",
        states: [
          {
            type: "tool",
            name: "First",
            toolRef: { name: "send", version: "1" },
            action: "do",
            destination: "slack",
            transition: "Done",
          },
          { type: "inject-like", name: "Done", end: true },
        ],
      }),
      def("Trigger", "on-flow", {
        type: "manual",
        routineRef: { name: "flow", version: "1" },
        eventType: "e",
        eventVersion: 1,
        backgroundIdentity: { principalKind: "service", principalId: "svc" },
        deduplication: { key: "k" },
      }),
    ];
    expect(() => validateSoulSemantics(docs)).not.toThrow();
  });

  it("rejects duplicate stable id and slug", () => {
    const docs = [
      model("a", {}),
      def(
        "ModelProfile",
        "b",
        {
          provider: "p",
          model: "m",
          reasoning: "low",
          supports: { tools: true, structuredOutput: true, contextWindowTokens: 1 },
          allowCaching: false,
        },
        { id: "id-ModelProfile-a" }
      ),
      def("Agent", "dup", {
        owner: "u",
        instructions: { path: "i.md" },
        modelProfile: "a",
        autonomy: "answer_only",
        trustTier: "first_party",
      }),
      def(
        "Agent",
        "dup",
        {
          owner: "u",
          instructions: { path: "i.md" },
          modelProfile: "a",
          autonomy: "answer_only",
          trustTier: "first_party",
        },
        { id: "other" }
      ),
    ];
    const c = codes(() => validateSoulSemantics(docs));
    expect(c).toContain("DUPLICATE_ID");
    expect(c).toContain("DUPLICATE_SLUG");
  });

  it("rejects an unresolved reference", () => {
    const docs = [
      model("fast"),
      def("Agent", "a", {
        owner: "u",
        instructions: { path: "i.md" },
        modelProfile: "fast",
        skills: ["missing"],
        autonomy: "answer_only",
        trustTier: "first_party",
      }),
    ];
    expect(codes(() => validateSoulSemantics(docs))).toEqual(["UNRESOLVED_REF"]);
  });

  it("rejects an unsatisfied version constraint", () => {
    const docs = [
      def("Routine", "flow", {
        owner: "u",
        start: "S",
        states: [{ type: "x", name: "S", end: true }],
      }),
      def("Trigger", "t", {
        type: "manual",
        routineRef: { name: "flow", version: "9" },
        eventType: "e",
        eventVersion: 1,
        backgroundIdentity: { principalKind: "service", principalId: "s" },
        deduplication: { key: "k" },
      }),
    ];
    expect(codes(() => validateSoulSemantics(docs))).toEqual(["VERSION_UNSATISFIED"]);
  });

  it("enforces the version constraint when a reference uses a stable id", () => {
    const routineId = "11111111-1111-1111-1111-111111111111";
    const docs = [
      def(
        "Routine",
        "flow",
        {
          owner: "u",
          start: "S",
          states: [{ type: "x", name: "S", end: true }],
        },
        { id: routineId, authoredVersion: 2 }
      ),
      def("Trigger", "t", {
        type: "manual",
        routineRef: { id: routineId, name: "flow", version: "1" },
        eventType: "e",
        eventVersion: 1,
        backgroundIdentity: { principalKind: "service", principalId: "s" },
        deduplication: { key: "k" },
      }),
    ];

    expect(codes(() => validateSoulSemantics(docs))).toEqual(["VERSION_UNSATISFIED"]);
  });

  it("rejects a broken Routine State graph", () => {
    const docs = [
      def("Routine", "flow", {
        owner: "u",
        start: "Nope",
        states: [
          { type: "x", name: "A", transition: "Ghost" },
          { type: "x", name: "A", end: true },
        ],
      }),
    ];
    const c = codes(() => validateSoulSemantics(docs));
    expect(c).toContain("ROUTINE_START_UNKNOWN");
    expect(c).toContain("ROUTINE_TRANSITION_UNKNOWN");
    expect(c).toContain("ROUTINE_DUPLICATE_STATE");
  });

  it("detects role inheritance and model fallback cycles", () => {
    const docs = [
      def("Role", "a", { principalTypes: ["agent"], inherits: ["b"], grants: [] }),
      def("Role", "b", { principalTypes: ["agent"], inherits: ["a"], grants: [] }),
      model("m1", { fallbacks: ["m2"] }),
      model("m2", { fallbacks: ["m1"] }),
    ];
    const c = codes(() => validateSoulSemantics(docs));
    expect(c).toContain("INHERITANCE_CYCLE");
    expect(c).toContain("FALLBACK_CYCLE");
  });

  it("rejects a Tool risk that exceeds the Agent permission ceiling (non-amplification)", () => {
    const docs = [
      model("fast"),
      tool("danger", { riskClass: "high", mutating: true, idempotency: { strategy: "provider" } }),
      def("Agent", "a", {
        owner: "u",
        instructions: { path: "i.md" },
        modelProfile: "fast",
        allowedTools: ["danger"],
        autonomy: "answer_only",
        trustTier: "first_party",
        permissionCeiling: { maxRiskClass: "low" },
      }),
    ];
    expect(codes(() => validateSoulSemantics(docs))).toEqual(["RISK_EXCEEDS_CEILING"]);
  });

  it("rejects a Routine plan dispatching to a destination the Tool contract forbids", () => {
    const docs = [
      tool("send", { allowedDestinations: ["slack"] }),
      def("Routine", "flow", {
        owner: "u",
        start: "S",
        states: [
          {
            type: "tool",
            name: "S",
            toolRef: { name: "send", version: "1" },
            action: "do",
            destination: "email",
            end: true,
          },
        ],
      }),
    ];
    expect(codes(() => validateSoulSemantics(docs))).toEqual(["DESTINATION_NOT_GRANTED"]);
  });

  it("produces deterministically sorted, payload-safe issues", () => {
    const docs = [
      def("Agent", "a", {
        owner: "u",
        instructions: { path: "i.md" },
        modelProfile: "gone",
        skills: ["gone"],
        autonomy: "answer_only",
        trustTier: "first_party",
      }),
    ];
    let issues: SoulSemanticValidationError["issues"] = [];
    try {
      validateSoulSemantics(docs);
    } catch (err) {
      if (err instanceof SoulSemanticValidationError) issues = err.issues;
    }
    const keys = issues.map((i) => `${i.subject} ${i.code} ${i.field ?? ""} ${i.ref ?? ""}`);
    expect(keys).toEqual([...keys].sort());
    // Payload-safe: no definition content leaks — only authored identifiers/pointers.
    for (const issue of issues) {
      expect(issue.subject).toBe("Agent:a");
      expect(Object.keys(issue).sort()).toEqual(["code", "field", "ref", "subject"]);
    }
  });
});
