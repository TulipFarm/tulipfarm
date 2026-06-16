import type { SoulAgent } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../context/assemble";
import { INFORMATION_ARCHITECT } from "../soul/agents/platform-agents";
import { assembleAgentSystemPrompt } from "./system-prompt";

const agent: SoulAgent = {
  name: "test-agent",
  frontmatter: { domain: "testing" },
  body: "You are a test agent.",
};

const empty = {
  memory: [],
  governanceDocs: [],
  availableSkills: [],
  eagerSkills: [],
  taggedResources: [],
};

describe("assembleAgentSystemPrompt", () => {
  it("matches a direct assembleSystemPrompt call when there is no platform agent", () => {
    // Guards the extraction from `routes.ts`: with no platform agent, forge skills are empty, so the
    // wrapper must produce byte-identical output to assembling the same durable inputs directly.
    const got = assembleAgentSystemPrompt({ agent, platformAgent: undefined, ...empty });
    const expected = assembleSystemPrompt({
      agentId: "test-agent",
      domain: "testing",
      tenantId: "default",
      personality: "You are a test agent.",
      ...empty,
    });
    expect(got).toBe(expected);
    expect(got).toContain("You are a test agent.");
  });

  it("merges the platform agent's forge skills into the available-skills index", () => {
    const withForge = assembleAgentSystemPrompt({
      agent,
      platformAgent: INFORMATION_ARCHITECT,
      ...empty,
    });
    const withoutForge = assembleAgentSystemPrompt({ agent, platformAgent: undefined, ...empty });
    expect(withForge).toContain("skill-forge");
    expect(withoutForge).not.toContain("skill-forge");
  });
});
