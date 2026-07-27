import type { SoulAgent } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../context/assemble";
import { DEFAULT_ASSISTANT } from "../soul/agents/platform-agents";
import type { SoulCatalogue } from "../soul/catalogue";
import type { BundledSkill } from "../soul/skills/bundled";
import { assembleAgentSystemPrompt } from "./system-prompt";

const agent: SoulAgent = {
  name: "test-agent",
  frontmatter: { domain: "testing" },
  body: "You are a test agent.",
};

const emptyCatalogue: SoulCatalogue = {
  agents: [],
  skills: [],
  resourceTypes: [],
  routines: [],
  integrations: [],
};

const empty = {
  memory: [],
  governancePages: [],
  availableSkills: [],
  eagerSkills: [],
  taggedResources: [],
  soulCatalogue: emptyCatalogue,
  availableTools: [],
};

const skillForge: BundledSkill = {
  name: "skill-forge",
  frontmatter: { name: "skill-forge", description: "Forge a Skill." },
  body: "Forge instructions.",
  category: "forge",
  categoryDescription: "Author Soul artifacts.",
  directory: "/app/skills/forge/skill-forge",
  references: [],
};
const bundledSkills = new Map([[skillForge.name, skillForge]]);

/** Inner text of one XML block, or "" when absent — lets a test scope assertions to a single block. */
function blockBody(prompt: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = prompt.indexOf(open);
  const j = prompt.indexOf(close);
  return i >= 0 && j >= 0 ? prompt.slice(i + open.length, j) : "";
}

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
      platformAgent: DEFAULT_ASSISTANT,
      bundledSkills,
      ...empty,
    });
    const withoutForge = assembleAgentSystemPrompt({ agent, platformAgent: undefined, ...empty });
    expect(withForge).toContain("skill-forge");
    expect(withoutForge).not.toContain("skill-forge");
  });

  it("threads the soul catalogue and tool index into their blocks; forge stays out of soul-context", () => {
    const out = assembleAgentSystemPrompt({
      agent,
      platformAgent: DEFAULT_ASSISTANT,
      bundledSkills,
      ...empty,
      soulCatalogue: {
        agents: [{ name: "support-agent", description: "Customer support" }],
        skills: [{ name: "catalogue-skill", description: "Repo skill" }],
        resourceTypes: [{ name: "invoice", description: "Billable items" }],
        routines: [],
        integrations: [],
      },
      availableTools: [{ name: "agent_list", description: "list agents" }],
    });
    expect(out).toContain("- catalogue-skill: Repo skill");
    expect(out).toContain("<available-tools>\n- agent_list: list agents\n</available-tools>");
    // Forge skills surface only in <available-skills>, never the soul-repo catalogue.
    expect(blockBody(out, "soul-context")).not.toContain("skill-forge");
    expect(out).toContain("skill-forge");
  });

  it("threads business.name/description into the business-context block", () => {
    const out = assembleAgentSystemPrompt({
      agent,
      platformAgent: undefined,
      business: { name: "Acme Corp", description: "Sells widgets." },
      ...empty,
    });
    expect(blockBody(out, "business-context")).toBe(
      "\nname: Acme Corp\ndescription: Sells widgets.\n"
    );
  });
});
