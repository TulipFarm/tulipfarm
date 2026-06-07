import { describe, expect, it } from "vitest";
import { resolveTier } from "./selection";

describe("resolveTier", () => {
  it("auto + supervised → standard (AC-V1-001)", () => {
    expect(resolveTier({ autonomy: "supervised" })).toBe("standard");
  });

  it("auto + full → quick", () => {
    expect(resolveTier({ autonomy: "full" })).toBe("quick");
  });

  it("auto + full + tools in scope → standard (bump)", () => {
    expect(resolveTier({ autonomy: "full", hasTools: true })).toBe("standard");
  });

  it("auto + approval-required → complex", () => {
    expect(resolveTier({ autonomy: "approval-required" })).toBe("complex");
  });

  it("auto + manual → standard", () => {
    expect(resolveTier({ autonomy: "manual" })).toBe("standard");
  });

  it("no autonomy → standard (default)", () => {
    expect(resolveTier({})).toBe("standard");
  });

  it("x-llm-decision forces complex over autonomy", () => {
    expect(resolveTier({ autonomy: "full", llmDecision: true })).toBe("complex");
  });

  it("complex is never bumped by tools", () => {
    expect(resolveTier({ autonomy: "approval-required", hasTools: true })).toBe("complex");
  });
});
