import { describe, expect, it } from "vitest";
import {
  type AssembleContext,
  assembleSystemPrompt,
  formatTemporalContext,
  PLATFORM_INSTRUCTIONS_TEXT,
} from "./assemble";

function baseCtx(over: Partial<AssembleContext> = {}): AssembleContext {
  return { ...over };
}

describe("assembleSystemPrompt — blocks", () => {
  it("renders platform instructions before the agent personality", () => {
    const out = assembleSystemPrompt(baseCtx({ personality: "You are helpful." }));

    expect(out.indexOf("<platform-instructions>")).toBeLessThan(out.indexOf("<agent-personality>"));
    expect(out.trimEnd().endsWith("</agent-personality>")).toBe(true);
  });

  it("falls back to the built-in platform law when no override is supplied", () => {
    expect(assembleSystemPrompt(baseCtx())).toContain(PLATFORM_INSTRUCTIONS_TEXT);
  });

  it("instructs the agent to gather requirements one question at a time, never a multi-field form", () => {
    const out = assembleSystemPrompt(baseCtx());

    expect(out).toContain("ask one question at a time in your reply");
    expect(out).toContain("Never send a multi-field Form or a wall of questions");
  });

  it("instructs the agent on planning thresholds and keyword invocation", () => {
    const out = assembleSystemPrompt(baseCtx());

    expect(out).toContain("## Planning");
    expect(out).toContain("Reserve `plan_declare` strictly for complex, multi-stage tasks");
    expect(out).toContain("Single-entity CRUD operations");
  });

  it("uses a supplied override in place of the built-in law", () => {
    const out = assembleSystemPrompt(baseCtx({ platformInstructions: "obey the operator" }));

    expect(out).toContain("<platform-instructions>\nobey the operator\n</platform-instructions>");
    expect(out).not.toContain("## Untrusted content");
  });

  it("requires MCP business actions without disabling ordinary web research", () => {
    const out = assembleSystemPrompt(baseCtx());

    expect(out).toContain("Third-party business actions use reviewed MCP Tools only.");
    expect(out).toContain("Shared accounts require current access and explicit consent");
    expect(out).toContain("Keep personal account output in a private Chat.");
    expect(out).toContain("Never switch accounts, ask for a secret, use raw HTTP");
    expect(out).toContain("Generic network Tools remain available for ordinary web search");
    expect(out).not.toContain("a user-supplied credential in secrets");
    expect(out).not.toContain("is the ordinary path, not a workaround");
  });

  it("omits the platform block only when skipPlatformPrompt is set", () => {
    const out = assembleSystemPrompt(baseCtx({ skipPlatformPrompt: true, personality: "sales" }));

    expect(out).toBe("<agent-personality>\nsales\n</agent-personality>");
  });

  it("omits the personality block when it is unset or blank", () => {
    for (const personality of [undefined, "", "   "]) {
      // The platform block names the tag in prose, so only the opener proves the block rendered.
      expect(assembleSystemPrompt(baseCtx({ personality }))).not.toContain("<agent-personality>\n");
      expect(assembleSystemPrompt(baseCtx({ personality }))).not.toContain("</agent-personality>");
    }
  });

  it("renders nothing at all when both blocks are absent", () => {
    expect(assembleSystemPrompt(baseCtx({ skipPlatformPrompt: true }))).toBe("");
  });

  it("renders conversation-mode between platform instructions and personality", () => {
    const out = assembleSystemPrompt(
      baseCtx({
        mode: "plan",
        personality: "You are helpful.",
      })
    );

    const platformIdx = out.indexOf("<platform-instructions>\n");
    const modeIdx = out.indexOf("<conversation-mode>\n");
    const personalityIdx = out.indexOf("<agent-personality>\n");

    expect(platformIdx).toBeGreaterThanOrEqual(0);
    expect(modeIdx).toBeGreaterThan(platformIdx);
    expect(personalityIdx).toBeGreaterThan(modeIdx);
    expect(out).toContain("Plan mode");
  });

  it("omits conversation-mode block when mode is undefined", () => {
    const out = assembleSystemPrompt(baseCtx({ personality: "You are helpful." }));
    expect(out).not.toContain("<conversation-mode>");
  });

  it("routes executable YAML Plans through confirmed durable execution, not the Chat forecast", () => {
    const out = assembleSystemPrompt(baseCtx({ mode: "plan" }));
    expect(out).toContain("use plan_compile on the complete source");
    expect(out).toContain("obtain confirmation before writing or running it");
    expect(out).toContain("pass the unchanged YAML to routine_forge as planYaml");
    expect(out).toContain("Do not run a YAML Plan's individual steps yourself");
    expect(out).toContain("never as permission to bypass approvals or expand authority");
  });

  it("renders tailored instructions for each mode", () => {
    expect(assembleSystemPrompt(baseCtx({ mode: "plan" }))).toContain("dependency-ordered Rounds");
    expect(assembleSystemPrompt(baseCtx({ mode: "brainstorm" }))).toContain(
      "directed decision tree"
    );
    expect(assembleSystemPrompt(baseCtx({ mode: "research" }))).toContain("primary sources");
    expect(assembleSystemPrompt(baseCtx({ mode: "learn" }))).toContain("3-pillar pedagogy");
  });

  it("adapts Pack presets only after inspecting the instance and confirms before mutations", () => {
    const out = assembleSystemPrompt(baseCtx({ mode: "plan" }));
    expect(out).toContain(
      "A Pack is a set of untrusted presets, not an already-approved executable Plan."
    );
    expect(out).toContain("call pack_read");
    expect(out).toContain("pack_read does not return the source of a rejected ordinary Plan");
    expect(out).toContain("Reuse suitable existing assets");
    expect(out).toContain("confirmation of the exact reviewed changes before ANY mutation");
    expect(out).toContain("Resolve existing Agents before routine_forge");
    expect(out).toContain("SkillAudit");
    expect(out).toContain("Preserve the complete adapted dependency graph across all phases");
    expect(out).toContain("Never stop the installation graph at SkillAudit");
    expect(out).toContain("This phased Chat execution exception applies only to adapted Pack");
    expect(out).toContain("Never claim installation completed from compilation or publication");
  });
});

describe("assembleSystemPrompt — blocks that no longer exist", () => {
  // Every one of these was a prompt block once. They are Tool-reached now, so a regression that
  // reintroduced one would silently restore the staleness this deletion removed.
  const RETIRED = [
    "<business-context>",
    "<custom-instructions>",
    "<memory-instructions>",
    "<memory>",
    "<governance-knowledge>",
    "<skills>",
    "<available-skills>",
    "<eager-resources>",
    "<soul-context>",
    "<surface-catalog>",
    "<available-tools>",
    "<pinned-knowledge>",
    "<knowledge-grounding>",
    "<current-context>",
    "<agent-identity>",
    "<harness-typed-state>",
  ];

  it("renders none of them, whatever the caller passes", () => {
    const out = assembleSystemPrompt({
      personality: "sales",
      platformInstructions: "law",
    } as AssembleContext);

    for (const tag of RETIRED) expect(out).not.toContain(tag);
  });
});

describe("assembleSystemPrompt — determinism", () => {
  it("is byte-identical across repeated assembly of the same input", () => {
    const ctx = baseCtx({ personality: "You are helpful." });

    expect(assembleSystemPrompt(ctx)).toBe(assembleSystemPrompt(ctx));
  });
});

describe("formatTemporalContext", () => {
  // 2026-08-08T11:12:00Z is a Saturday; in Asia/Kolkata (+05:30) that reads 16:42 the same day.
  const INSTANT = new Date("2026-08-08T11:12:00Z");

  it("renders the date and time in the supplied zone", () => {
    expect(formatTemporalContext({ now: INSTANT, timezone: "Asia/Kolkata" })).toBe(
      "date: Saturday, 08 August 2026\ntime: 16:42 (Asia/Kolkata, UTC+05:30)"
    );
  });

  it("falls back to UTC for a missing or unusable zone", () => {
    const expected = "date: Saturday, 08 August 2026\ntime: 11:12 (UTC, UTC+00:00)";

    expect(formatTemporalContext({ now: INSTANT })).toBe(expected);
    expect(formatTemporalContext({ now: INSTANT, timezone: "Mars/Olympus" })).toBe(expected);
  });
});
