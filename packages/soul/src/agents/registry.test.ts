import { describe, expect, it } from "vitest";
import type { SoulLoader } from "../published-loader";
import type { SoulAgent } from "../types";
import { agentIdOf } from "./agent-id";
import { DEFAULT_ASSISTANT, getAgent, listAgents, resolveAgent } from "./registry";

function makeSoulLoader(agents: SoulAgent[] = []): SoulLoader {
  return { agents: new Map(agents.map((agent) => [agent.name, agent])) } as unknown as SoulLoader;
}

const PLANNER: SoulAgent = {
  id: agentIdOf("sprint-planner", {}),
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

  it("resolves a selected Soul agent by name or by id", () => {
    const loader = makeSoulLoader([PLANNER]);
    expect(resolveAgent(loader, "sprint-planner")).toBe(PLANNER);
    expect(resolveAgent(loader, PLANNER.id)).toBe(PLANNER);
  });

  it("refuses a reference the Soul does not have rather than substituting the default", () => {
    const loader = makeSoulLoader([PLANNER]);
    expect(resolveAgent(loader, "missing-agent")).toBeUndefined();
    expect(resolveAgent(undefined, "missing-agent")).toBeUndefined();
  });

  it("lists and retrieves only user-created Soul agents", () => {
    const loader = makeSoulLoader([PLANNER]);
    expect(listAgents(undefined)).toEqual([]);
    expect(listAgents(loader)).toEqual([PLANNER]);
    expect(getAgent(loader, "sprint-planner")).toBe(PLANNER);
    expect(getAgent(loader, "__tulipfarm_default__")).toBeUndefined();
  });
});
