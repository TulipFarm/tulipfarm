import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseSoulFile } from "./parse";

const upsert = (path: string, content: string) => ({ operation: "upsert", path, content }) as const;

const AGENT_DEFINITION = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Agent",
  metadata: {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "ada",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "draft",
  },
  spec: {
    owner: "prin_1",
    instructions: { path: "instructions.md" },
    modelProfile: "sol-high",
    autonomy: "answer_only",
    trustTier: "first_party",
  },
};

const LEGACY_AGENT_MD = `---
label: Ada
description: Handles support triage
autonomy: supervised
---

You are Ada.
`;

const LEGACY_SKILL_MD = `---
name: triage
description: Triages inbound issues
---

Steps to triage.
`;

const LEGACY_RESOURCE_YML = stringify({
  type: "object",
  properties: { email: { type: "string", "x-normalize": ["trim", "email-normalize"] } },
});

const VALID_LEGACY_ROUTINE_YAML = stringify({
  id: "routine-1",
  version: "1",
  start: "Start",
  states: [{ name: "Start", type: "inject", data: {} }],
  "x-triggers": [{ type: "manual" }],
});

/** Regression: the write gate must use schema-owned layout paths, not stale hardcoded paths. */
describe("parseSoulFile admits what the runtime actually writes", () => {
  it.each([
    ["agents/ada/AGENT.md", LEGACY_AGENT_MD, "legacy"],
    ["skills/triage/SKILL.md", LEGACY_SKILL_MD, "legacy"],
    ["resources/employee/schema.yml", LEGACY_RESOURCE_YML, "legacy"],
    ["routines/onboarding/routine.yaml", VALID_LEGACY_ROUTINE_YAML, "legacy"],
    ["soul.yaml", stringify({ name: "acme" }), "legacy"],
    ["skills-lock.json", "{}", "managed"],
    ["integrations/github/connection.yaml", stringify({ connected: true }), "managed"],
    ["integrations/github/setup-guide.md", "# Setup", "prose"],
    ["agents/ada/instructions.md", "You are Ada.", "prose"],
    ["resources/employee/hooks.ts", "export const before = () => {};", "executable"],
    ["skills/triage/scripts/run.py", "print(1)", "executable"],
  ])("admits %s", (path, content, mode) => {
    const result = parseSoulFile(upsert(path, content));
    expect(result.issue).toBeUndefined();
    expect(result.parsed?.mode).toBe(mode);
  });

  it("admits a canonical definition and reports it as such", () => {
    const result = parseSoulFile(upsert("agents/ada/agent.yaml", stringify(AGENT_DEFINITION)));
    expect(result.issue).toBeUndefined();
    expect(result.parsed?.mode).toBe("definition");
    expect(result.parsed?.definition?.kind).toBe("Agent");
    expect(result.parsed?.kind).toBe("Agent");
    expect(result.parsed?.slug).toBe("ada");
  });

  it("reads a SKILL.md with no frontmatter as prose rather than as configuration", () => {
    const result = parseSoulFile(
      upsert("skills/triage/SKILL.md", "Just the body, no frontmatter.")
    );
    expect(result.parsed?.mode).toBe("prose");
  });
});

describe("parseSoulFile still enforces content", () => {
  it("rejects an unsupported path", () => {
    const result = parseSoulFile(upsert("secrets/.env", "TOKEN=1"));
    expect(result.issue?.code).toBe("UNSUPPORTED_SOUL_PATH");
  });

  it("rejects path traversal", () => {
    expect(parseSoulFile(upsert("../../etc/passwd", "x")).issue?.code).toBe(
      "UNSUPPORTED_SOUL_PATH"
    );
  });

  it("rejects a definition filed under the wrong kind's directory", () => {
    const result = parseSoulFile(upsert("roles/ada/role.yaml", stringify(AGENT_DEFINITION)));
    expect(result.issue?.code).toBe("KIND_PATH_MISMATCH");
  });

  it("rejects an invalid canonical definition", () => {
    const broken = { ...AGENT_DEFINITION, spec: { autonomy: "not-a-real-ceiling" } };
    const result = parseSoulFile(upsert("agents/ada/agent.yaml", stringify(broken)));
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("validates legacy frontmatter rather than blindly hashing it", () => {
    const result = parseSoulFile(
      upsert("agents/ada/AGENT.md", "---\nautonomy: wrong-value\n---\nbody")
    );
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("rejects an unknown key in legacy frontmatter", () => {
    const result = parseSoulFile(upsert("agents/ada/AGENT.md", "---\nsudo: true\n---\nbody"));
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("rejects a legacy resource schema using an unknown normalizer", () => {
    const bad = stringify({
      type: "object",
      properties: { email: { type: "string", "x-normalize": ["not-a-normalizer"] } },
    });
    const result = parseSoulFile(upsert("resources/employee/schema.yml", bad));
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("admits a valid guardrails policy", () => {
    const valid = stringify({
      input: [{ guard: "prompt_injection", sensitivity: "medium" }],
      output: [{ guard: "content_filter", patterns: ["ssn"] }],
    });
    const result = parseSoulFile(upsert("guardrails.yaml", valid));
    expect(result.issue).toBeUndefined();
    expect(result.parsed?.mode).toBe("delegated");
  });

  it("rejects a guardrails policy that puts a guard in the wrong stage", () => {
    const bad = stringify({ input: [{ guard: "content_filter", patterns: ["ssn"] }] });
    const result = parseSoulFile(upsert("guardrails.yaml", bad));
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("rejects a legacy file that is not even YAML", () => {
    const result = parseSoulFile(upsert("routines/onboarding/routine.yaml", "\t- [unclosed"));
    expect(result.issue?.code).toBe("FILE_PARSE_FAILED");
  });

  it("rejects invalid SKILL.md frontmatter instead of downgrading it to prose", () => {
    const result = parseSoulFile(upsert("skills/triage/SKILL.md", "---\nname: [bad\n---\nbody"));
    expect(result.issue?.code).toBe("FILE_PARSE_FAILED");
  });

  it("validates legacy routine.yaml against the Routine schema", () => {
    const result = parseSoulFile(
      upsert("routines/onboarding/routine.yaml", stringify({ name: "onboarding", states: [] }))
    );
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("validates legacy manifest.yml instead of accepting any YAML mapping", () => {
    const result = parseSoulFile(upsert("integrations/github/manifest.yml", stringify({})));
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("validates soul.yaml LLM config when the legacy manifest carries one", () => {
    const result = parseSoulFile(upsert("soul.yaml", stringify({ llm: { tiers: {} } })));
    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  /**
   * Every publication re-parses the whole committed tree, and `scaffoldSoul` commits a comment-only
   * `soul.yaml`. Refusing it wedges bundle publication for the business permanently.
   */
  it.each([
    ["comment-only", "# TulipFarm Soul Configuration\n"],
    ["blank", "\n"],
  ])("admits a %s soul.yaml as empty configuration", (_label, content) => {
    const result = parseSoulFile(upsert("soul.yaml", content));
    expect(result.issue).toBeUndefined();
    expect(result.parsed?.mode).toBe("legacy");
  });

  it("hashes a delete by path without needing content", () => {
    const result = parseSoulFile({ operation: "delete", path: "agents/ada/agent.yaml" });
    expect(result.issue).toBeUndefined();
    expect(result.parsed?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to delete a path the tree does not govern", () => {
    const result = parseSoulFile({ operation: "delete", path: "../escape.yaml" });
    expect(result.issue?.code).toBe("UNSUPPORTED_SOUL_PATH");
  });

  // The server writes `_pendingAudit` itself so a newly created Skill lands committed but inactive.
  // Re-checking stored frontmatter as if an author had written it rejected the very file the write
  // gateway was being asked to commit, which made every Agent-authored Skill uncommittable.
  it("admits a stored SKILL.md carrying the runtime's own pending-audit marker", () => {
    const content = `---\n${stringify({ name: "triage", description: "d", _pendingAudit: true })}---\nbody`;
    const result = parseSoulFile(upsert("skills/triage/SKILL.md", content));

    expect(result.issue).toBeUndefined();
    expect(result.parsed?.mode).toBe("legacy");
  });

  it("still refuses other reserved frontmatter keys in a stored SKILL.md", () => {
    const content = `---\n${stringify({ name: "triage", description: "d", _grants: ["admin"] })}---\nbody`;
    const result = parseSoulFile(upsert("skills/triage/SKILL.md", content));

    expect(result.issue?.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("admits the companion files a real Skill package ships beside SKILL.md", () => {
    for (const path of [
      "skills/triage/references/playbook.md",
      "skills/triage/scripts/convert.py",
      "skills/triage/LICENSE.txt",
      "skills/triage/requirements.txt",
      "skills/triage/README.md",
    ]) {
      expect(parseSoulFile(upsert(path, "content\n")).issue, path).toBeUndefined();
    }
  });
});
