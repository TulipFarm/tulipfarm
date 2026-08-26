import { describe, expect, it } from "vitest";
import { DEFAULT_ASSISTANT, DEFAULT_ASSISTANT_NAME, getDefaultAssistant } from "./platform-agents";

describe("default chat harness", () => {
  it("is an internal normal-chat identity rather than a selectable Soul agent", () => {
    expect(DEFAULT_ASSISTANT.name).toBe(DEFAULT_ASSISTANT_NAME);
    expect(getDefaultAssistant(DEFAULT_ASSISTANT_NAME)).toBe(DEFAULT_ASSISTANT);
    expect(getDefaultAssistant("support-agent")).toBeUndefined();
  });

  it("combines TulipFarm's business-building role with execution discipline", () => {
    expect(DEFAULT_ASSISTANT.body).toContain("## Building the system");
    expect(DEFAULT_ASSISTANT.body).toContain("## Acting");
    expect(DEFAULT_ASSISTANT.body).toContain("Never describe a call you could make");
    expect(DEFAULT_ASSISTANT.body).toContain("confirm it with the matching read, list, or status");
    expect(DEFAULT_ASSISTANT.body).toContain(
      "Issue every independent Tool call in the same response"
    );
  });

  /**
   * The prompt carries no facts, so an instruction to read one from Context would send the model
   * looking somewhere empty. Every fact the body asks for has to name the Tool that returns it.
   */
  it("names the Tool behind every fact it tells the model to know", () => {
    for (const tool of [
      "get_business_profile",
      "get_memory",
      "get_current_time",
      "get_current_agent",
      "list_governance_pages",
    ]) {
      expect(DEFAULT_ASSISTANT.body).toContain(tool);
    }
    expect(DEFAULT_ASSISTANT.body).toContain("Every fact about the business");
  });

  // What the Soul holds arrives in the per-Turn reminder, so pointing at a list Tool for it spends
  // a Turn re-reading what the model was already handed — which is exactly what it did.
  it("sends the model to the reminder for the Soul catalogue, not to a list Tool", () => {
    for (const tag of ["<available-skills>", "<available-agents>", "<available-resources>"]) {
      expect(DEFAULT_ASSISTANT.body).toContain(tag);
    }
    expect(DEFAULT_ASSISTANT.body).not.toContain("list_resource_types");
  });

  // The two-phase write made "Soul writes are ungated ... never ask for approval" false, and a
  // prompt that says so talks the model past the one gate SkillAudit has.
  it("tells the model a Skill write is audited, confirmed, and approved by a human", () => {
    expect(DEFAULT_ASSISTANT.body).toContain("two calls");
    expect(DEFAULT_ASSISTANT.body).toContain("confirm");
    expect(DEFAULT_ASSISTANT.body).not.toContain("Soul writes are ungated");
  });
});
