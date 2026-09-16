import { describe, expect, it } from "vitest";
import { chatRequestMode } from "./request-mode";

describe("participant Pack intent", () => {
  it.each([
    "Install the pack - https://packs.example.com/asdf",
    "Preview this Pack https://example.com/preset?id=sales",
    "Import a pack:\napiVersion: tulipfarm.ai/v1\nkind: Pack\nname: sales",
  ])("selects Plan mode for %s", (content) => {
    expect(chatRequestMode(content, undefined)).toBe("plan");
  });

  it("keeps confirmation follow-ups in the selected mode", () => {
    expect(chatRequestMode("Confirm these changes", undefined, "plan")).toBe("plan");
  });

  it("preserves ordinary YAML Plans", () => {
    expect(chatRequestMode("apiVersion: tulipfarm.ai/v1\nkind: Plan\nname: sales")).toBe("plan");
  });

  it.each(["Read https://example.com/asdf", "Tell me what Packs are", "Install a skill"])(
    "does not switch modes for %s",
    (content) => {
      expect(chatRequestMode(content, "research")).toBe("research");
    }
  );
});
