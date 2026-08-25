import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENTS } from "./registry";

/**
 * The reason this package exists, asserted.
 *
 * Five single-shot model calls lived in two applications and drifted: two fenced their untrusted
 * input and three did not, two bounded their output and three ran unbounded. None of that was a
 * decision — it is what happens when one job is done in five directories with no list of them.
 * These tests fail the build when a sixth arrives in the same state.
 */

describe("BUILT_IN_AGENTS", () => {
  it("holds every shipped agent", () => {
    expect(BUILT_IN_AGENTS.map((agent) => agent.id).sort()).toEqual([
      "chat_title",
      "effort_classifier",
      "onboarding_personalizer",
      "skill_audit",
      "tool_result_distiller",
    ]);
  });

  it("gives every agent a unique id", () => {
    const ids = BUILT_IN_AGENTS.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BUILT_IN_AGENTS.map((agent) => [agent.id, agent] as const))(
    "%s declares its bounds",
    (_id, agent) => {
      // Without a ceiling, an agent reading attacker-supplied text can be made to talk until the
      // provider stops it, on the operator's key.
      expect(agent.maxOutputTokens).toBeGreaterThan(0);
      // Without a deadline, one stalled provider call holds a request or a Turn open indefinitely.
      expect(agent.timeoutMs).toBeGreaterThan(0);
      expect(agent.purpose.trim().length).toBeGreaterThan(0);
    }
  );

  it.each(BUILT_IN_AGENTS.map((agent) => [agent.id, agent] as const))(
    "%s routes to a concrete cheap rung",
    (_id, agent) => {
      // `auto` would route itself through the classifier, which is a BuiltInAgent. `thorough`
      // would mean an Agent's job is being done somewhere with no Run, no Tools and no audit.
      expect(["fast", "balanced"]).toContain(agent.rung);
    }
  );
});
