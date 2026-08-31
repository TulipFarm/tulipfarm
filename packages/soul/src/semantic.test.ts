import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  MAX_REF_SUGGESTIONS,
  type SoulSemanticIssue,
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

/** Catch and return the thrown error's issues, or fail if nothing was thrown. */
function issuesOf(fn: () => void): readonly SoulSemanticIssue[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof SoulSemanticValidationError) return err.issues;
    throw err;
  }
  throw new Error("expected SoulSemanticValidationError");
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

  it("suggests the resolvable Skill names on an unresolved reference", () => {
    const docs = [
      model("fast"),
      def("Skill", "invoicing", { instructions: { path: "i.md" } }),
      def("Skill", "onboarding", { instructions: { path: "i.md" } }),
      def("Agent", "a", {
        owner: "u",
        instructions: { path: "i.md" },
        modelProfile: "fast",
        skills: ["invoicng"],
        autonomy: "answer_only",
        trustTier: "first_party",
      }),
    ];
    const [issue] = issuesOf(() => validateSoulSemantics(docs));
    expect(issue.code).toBe("UNRESOLVED_REF");
    // The closer edit-distance match ("invoicing") sorts ahead of the unrelated "onboarding".
    expect(issue.candidates).toEqual(["invoicing", "onboarding"]);
  });

  it("caps unresolved-reference suggestions at MAX_REF_SUGGESTIONS", () => {
    const skillCount = MAX_REF_SUGGESTIONS + 5;
    const docs: VersionedSchemaDocument[] = [
      model("fast"),
      ...Array.from({ length: skillCount }, (_, i) =>
        def("Skill", `skill-${i}`, { instructions: { path: "i.md" } })
      ),
      def("Agent", "a", {
        owner: "u",
        instructions: { path: "i.md" },
        modelProfile: "fast",
        skills: ["does-not-exist"],
        autonomy: "answer_only",
        trustTier: "first_party",
      }),
    ];
    const [issue] = issuesOf(() => validateSoulSemantics(docs));
    expect(issue.code).toBe("UNRESOLVED_REF");
    expect(issue.candidates?.length).toBe(MAX_REF_SUGGESTIONS);
  });

  it("never suggests a name of a different kind than the unresolved reference", () => {
    const docs = [
      model("fast"),
      def("ModelProfile", "decoy", {
        provider: "p",
        model: "m",
        reasoning: "low",
        supports: { tools: true, structuredOutput: true, contextWindowTokens: 1 },
        allowCaching: false,
      }),
      def("Agent", "a", {
        owner: "u",
        instructions: { path: "i.md" },
        modelProfile: "fast",
        // "missing" resolves against no Skill, so the ModelProfile named "decoy" — even one that
        // exists in the same tree — must never appear in this Skill-kind suggestion list.
        skills: ["missing"],
        autonomy: "answer_only",
        trustTier: "first_party",
      }),
    ];
    const [issue] = issuesOf(() => validateSoulSemantics(docs));
    expect(issue.code).toBe("UNRESOLVED_REF");
    expect(issue.candidates).toEqual([]);
    expect(issue.candidates).not.toContain("decoy");
  });

  it("rejects an unsatisfied version constraint", () => {
    const docs = [
      def("Routine", "flow", {
        owner: "u",
        start: "S",
        states: [{ type: "x", name: "S", end: true }],
      }),
      def("Routine", "parent", {
        owner: "u",
        start: "S",
        states: [
          {
            type: "child_routine",
            name: "S",
            routineRef: { name: "flow", version: "9" },
            end: true,
          },
        ],
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
      def("Routine", "parent", {
        owner: "u",
        start: "S",
        states: [
          {
            type: "child_routine",
            name: "S",
            routineRef: { id: routineId, name: "flow", version: "1" },
            end: true,
          },
        ],
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

  it("accepts a Skill command bound to a sandbox ToolContract", () => {
    const docs = [
      tool("classify", {
        adapter: { kind: "sandbox", ref: "skill:issue-triage/classify_issue" },
      }),
      def("Skill", "issue-triage", {
        instructions: { path: "SKILL.md" },
        scripts: ["scripts/classify.ts"],
        commands: [
          {
            name: "classify_issue",
            toolRef: "classify",
            runtimeProfile: "shell-ts-python-v1",
            entrypoint: "scripts/classify.ts",
          },
        ],
        trustTier: "first_party",
      }),
    ];
    expect(() => validateSoulSemantics(docs)).not.toThrow();
  });

  it("rejects unsafe or inconsistent Skill command bindings", () => {
    const docs = [
      tool("classify"),
      def("Skill", "issue-triage", {
        instructions: { path: "SKILL.md" },
        scripts: ["scripts/other.ts"],
        commands: [
          {
            name: "classify_issue",
            toolRef: "classify",
            runtimeProfile: "shell-ts-python-v1",
            entrypoint: "scripts/classify.ts",
          },
          {
            name: "classify_issue",
            toolRef: "classify",
            runtimeProfile: "shell-ts-python-v1",
            entrypoint: "scripts/classify.ts",
          },
        ],
        trustTier: "first_party",
      }),
    ];
    const c = codes(() => validateSoulSemantics(docs));
    expect(c).toContain("SKILL_DUPLICATE_COMMAND");
    expect(c).toContain("SKILL_ENTRYPOINT_UNDECLARED");
    expect(c).toContain("SKILL_TOOL_ADAPTER_INVALID");
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
    // Payload-safe: no definition content leaks — only authored identifiers/pointers, plus the
    // candidates array UNRESOLVED_REF carries (itself only ever authored slugs, never content).
    for (const issue of issues) {
      expect(issue.subject).toBe("Agent:a");
      const expectedKeys =
        issue.code === "UNRESOLVED_REF"
          ? ["candidates", "code", "field", "ref", "subject"]
          : ["code", "field", "ref", "subject"];
      expect(Object.keys(issue).sort()).toEqual(expectedKeys);
    }
  });
});

describe("Trigger names across Routines", () => {
  function routineWithTrigger(slug: string, triggerName: string): VersionedSchemaDocument {
    return def("Routine", slug, {
      owner: "operations",
      start: "Done",
      states: [{ name: "Done", type: "branch", conditions: [{ condition: "true", end: true }] }],
      triggers: [{ name: triggerName, type: "manual" }],
    });
  }

  // The name is a URL segment, so two claimants make webhook delivery resolve by load order.
  it("refuses two Routines claiming one Trigger name, naming both claimants", () => {
    expect(() =>
      validateSoulSemantics([
        routineWithTrigger("daily-report", "shared-hook"),
        routineWithTrigger("weekly-report", "shared-hook"),
      ])
    ).toThrow(SoulSemanticValidationError);
    expect(
      codes(() =>
        validateSoulSemantics([
          routineWithTrigger("daily-report", "shared-hook"),
          routineWithTrigger("weekly-report", "shared-hook"),
        ])
      )
    ).toEqual(["TRIGGER_NAME_CONFLICT", "TRIGGER_NAME_CONFLICT"]);
  });

  it("accepts distinct Trigger names across Routines", () => {
    expect(() =>
      validateSoulSemantics([
        routineWithTrigger("daily-report", "daily-hook"),
        routineWithTrigger("weekly-report", "weekly-hook"),
      ])
    ).not.toThrow();
  });
});
