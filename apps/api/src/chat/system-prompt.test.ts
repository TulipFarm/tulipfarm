import { assembleSystemPrompt } from "@tulipfarm/agent-runtime";
import type { SoulAgent } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { assembleAgentSystemPrompt } from "./system-prompt";

const agent: SoulAgent = {
  name: "test-agent",
  frontmatter: { domain: "testing" },
  body: "You are a test agent.",
};

/**
 * Blocks the assembler used to render. Each one is now reached through a Tool, so a tag reappearing
 * here is a prompt block returning by the back door — the regression this file exists to catch.
 */
const RETIRED = [
  "agent-identity",
  "business-context",
  "custom-instructions",
  "memory-instructions",
  "memory",
  "governance-knowledge",
  "skills",
  "available-skills",
  "eager-resources",
  "soul-context",
  "pinned-knowledge",
  "knowledge-grounding",
  "current-context",
  "available-tools",
  "surface-catalog",
];

describe("assembleAgentSystemPrompt", () => {
  it("is exactly assembleSystemPrompt over the Agent's AGENT.md body", () => {
    expect(assembleAgentSystemPrompt({ agent })).toBe(
      assembleSystemPrompt({ personality: agent.body })
    );
  });

  it("renders the platform law and the personality, and nothing else", () => {
    const out = assembleAgentSystemPrompt({ agent });

    expect(out).toContain("<platform-instructions>");
    expect(out).toContain("<agent-personality>");
    expect(out).toContain("You are a test agent.");
    for (const tag of RETIRED) expect(out).not.toContain(`<${tag}>`);
  });
});
