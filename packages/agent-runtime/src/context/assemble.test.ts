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

  it("uses a supplied override in place of the built-in law", () => {
    const out = assembleSystemPrompt(baseCtx({ platformInstructions: "obey the operator" }));

    expect(out).toContain("<platform-instructions>\nobey the operator\n</platform-instructions>");
    expect(out).not.toContain("## Untrusted content");
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
