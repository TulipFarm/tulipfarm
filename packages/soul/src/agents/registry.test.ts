import { describe, expect, it } from "vitest";
import type { SoulLoader } from "../published-loader";
import type { SoulAgent } from "../types";
import { DEFAULT_ASSISTANT, getAgent, listAgents, resolveAgent } from "./registry";

function makeSoulLoader(agents: SoulAgent[] = []): SoulLoader {
  return { agents: new Map(agents.map((agent) => [agent.name, agent])) } as unknown as SoulLoader;
}

const PLANNER: SoulAgent = {
  name: "sprint-planner",
  frontmatter: { label: "Sprint Planner", domain: "engineering" },
  body: "# Role\nYou plan sprints.",
};

describe("agent registry", () => {
  it("uses an unlisted default harness for ordinary chat", () => {
    expect(resolveAgent(undefined, undefined)).toBe(DEFAULT_ASSISTANT);
    expect(DEFAULT_ASSISTANT.forgeSkills).toEqual(
      expect.arrayContaining(["resource-forge", "skill-forge", "agent-forge", "routine-forge"])
    );
  });

  it("resolves a selected Soul agent, otherwise falls back to normal chat", () => {
    const loader = makeSoulLoader([PLANNER]);
    expect(resolveAgent(loader, "sprint-planner")).toBe(PLANNER);
    expect(resolveAgent(loader, "missing-agent")).toBe(DEFAULT_ASSISTANT);
  });

  it("lists and retrieves only user-created Soul agents", () => {
    const loader = makeSoulLoader([PLANNER]);
    expect(listAgents(undefined)).toEqual([]);
    expect(listAgents(loader)).toEqual([PLANNER]);
    expect(getAgent(loader, "sprint-planner")).toBe(PLANNER);
    expect(getAgent(loader, "__tulipfarm_default__")).toBeUndefined();
  });
});
