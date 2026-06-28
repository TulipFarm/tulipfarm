import { describe, expect, it } from "vitest";
import type { ChecklistSignals } from "./checklist";
import { evaluateRules } from "./rules";

function signals(overrides: Partial<ChecklistSignals> = {}): ChecklistSignals {
  return {
    hasResource: false,
    hasSkill: false,
    hasAgent: false,
    hasKnowledge: false,
    ...overrides,
  };
}

describe("evaluateRules", () => {
  it("fires nothing on empty signals", () => {
    expect(evaluateRules(signals())).toEqual([]);
  });

  it("fires agent-for-resource only when a resource exists but no agent, naming the resource", () => {
    const recs = evaluateRules(signals({ hasResource: true, firstResourceName: "tickets" }));
    const rec = recs.find((r) => r.id === "agent-for-resource");
    expect(rec).toBeDefined();
    expect(rec?.label).toContain("tickets");
    expect(rec?.prompt).toContain("tickets");
  });

  it("does not fire agent-for-resource once an agent exists", () => {
    const recs = evaluateRules(signals({ hasResource: true, hasAgent: true }));
    expect(recs.map((r) => r.id)).not.toContain("agent-for-resource");
  });

  it("fires knowledge-for-agent and skill-after-agent together for an agent with no skill/knowledge", () => {
    const ids = evaluateRules(signals({ hasAgent: true })).map((r) => r.id);
    expect(ids).toContain("knowledge-for-agent");
    expect(ids).toContain("skill-after-agent");
  });

  it("suppresses knowledge-for-agent once knowledge exists", () => {
    const ids = evaluateRules(signals({ hasAgent: true, hasKnowledge: true })).map((r) => r.id);
    expect(ids).not.toContain("knowledge-for-agent");
  });

  it("every recommendation has an id, a label, and a non-empty prompt", () => {
    const recs = evaluateRules(
      signals({ hasResource: true, hasAgent: true, firstResourceName: "tickets" })
    );
    for (const r of recs) {
      expect(r.id).toBeTruthy();
      expect(r.label).toBeTruthy();
      expect(r.prompt.length).toBeGreaterThan(0);
    }
  });
});
