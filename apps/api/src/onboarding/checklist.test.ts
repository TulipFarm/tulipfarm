import { describe, expect, it } from "vitest";
import { buildChecklist, buildSteps, deriveSignals, type SoulSlice } from "./checklist";

function soul(
  opts: { resources?: string[]; skills?: string[]; agents?: string[] } = {}
): SoulSlice {
  const toMap = (names: string[] = []) => new Map(names.map((n) => [n, {}]));
  return {
    resources: toMap(opts.resources),
    skills: toMap(opts.skills),
    agents: toMap(opts.agents),
  } as unknown as SoulSlice;
}

describe("deriveSignals", () => {
  it("flips each signal from the corresponding map size", () => {
    const sig = deriveSignals(soul({ resources: ["tickets"], skills: ["s"], agents: ["a"] }), true);
    expect(sig).toEqual({
      hasResource: true,
      hasSkill: true,
      hasAgent: true,
      hasKnowledge: true,
      firstResourceName: "tickets",
    });
  });

  it("is all-false on an empty soul with no knowledge", () => {
    const sig = deriveSignals(soul(), false);
    expect(sig.hasResource).toBe(false);
    expect(sig.hasSkill).toBe(false);
    expect(sig.hasAgent).toBe(false);
    expect(sig.hasKnowledge).toBe(false);
    expect(sig.firstResourceName).toBeUndefined();
  });

  it("picks the alphabetically-first resource name for stable recommendation text", () => {
    const sig = deriveSignals(soul({ resources: ["zebras", "apples"] }), false);
    expect(sig.firstResourceName).toBe("apples");
  });
});

describe("buildSteps", () => {
  const empty = deriveSignals(soul(), false);

  it("emits the six steps in fixed order", () => {
    expect(buildSteps(empty).map((s) => s.id)).toEqual([
      "resource",
      "skill",
      "agent",
      "knowledge",
      "routine",
      "integration",
    ]);
  });

  it("marks all four core steps todo (with prompts) and routine/integration coming-soon on a fresh instance", () => {
    const steps = buildSteps(empty);
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    for (const id of ["resource", "skill", "agent", "knowledge"]) {
      expect(byId[id].status).toBe("todo");
      expect(byId[id].prompt).toBeTruthy();
    }
    expect(byId.routine.status).toBe("coming-soon");
    expect(byId.integration.status).toBe("coming-soon");
    expect(byId.routine.prompt).toBeUndefined();
    expect(byId.integration.prompt).toBeUndefined();
  });

  it("marks a step done (no prompt) once its signal is true", () => {
    const steps = buildSteps(deriveSignals(soul({ resources: ["tickets"] }), false));
    const resource = steps.find((s) => s.id === "resource");
    expect(resource?.status).toBe("done");
    expect(resource?.prompt).toBeUndefined();
  });

  it("interpolates businessName into todo prompts, unchanged when absent", () => {
    const generic = buildSteps(empty).find((s) => s.id === "resource")?.prompt;
    expect(generic).toBe("Help me create a resource type.");
    const named = buildSteps(deriveSignals(soul(), false, "Acme")).find((s) => s.id === "resource");
    expect(named?.prompt).toBe("Help me create a resource type for Acme.");
  });

  it("marks all four core steps done when every signal is true", () => {
    const steps = buildSteps(
      deriveSignals(soul({ resources: ["r"], skills: ["s"], agents: ["a"] }), true)
    );
    expect(steps.filter((s) => s.status === "done").map((s) => s.id)).toEqual([
      "resource",
      "skill",
      "agent",
      "knowledge",
    ]);
  });
});

describe("buildChecklist", () => {
  it("returns no recommendations on an empty soul", () => {
    expect(buildChecklist(soul(), false).recommendations).toEqual([]);
  });

  it("recommends an agent for an existing resource type", () => {
    const { recommendations } = buildChecklist(soul({ resources: ["tickets"] }), false);
    expect(recommendations.map((r) => r.id)).toContain("agent-for-resource");
    expect(recommendations.find((r) => r.id === "agent-for-resource")?.label).toContain("tickets");
  });
});
