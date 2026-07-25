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
    expect(DEFAULT_ASSISTANT.body).toContain("## Execution discipline");
    expect(DEFAULT_ASSISTANT.body).toContain("Do not describe an action you could");
    expect(DEFAULT_ASSISTANT.body).toContain("verify the result");
    expect(DEFAULT_ASSISTANT.body).toContain("never invent a successful result");
    expect(DEFAULT_ASSISTANT.body).toContain("Batch independent reads, searches, and lookups");
    expect(DEFAULT_ASSISTANT.body).toContain("active autonomy and approval rules");
  });
});
