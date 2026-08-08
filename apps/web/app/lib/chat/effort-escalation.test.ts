import { describe, expect, it } from "vitest";
import { nextEffortPreset } from "./effort-escalation";

describe("nextEffortPreset", () => {
  it("moves one step up the explicit effort ladder", () => {
    expect(nextEffortPreset("fast")).toBe("balanced");
    expect(nextEffortPreset("balanced")).toBe("thorough");
  });

  it("returns no target at the top of the ladder", () => {
    expect(nextEffortPreset("thorough")).toBeUndefined();
  });

  it("escalates Auto from the rung the backend reports it applied", () => {
    expect(nextEffortPreset("auto", "fast")).toBe("balanced");
    expect(nextEffortPreset("auto", "balanced")).toBe("thorough");
    expect(nextEffortPreset("auto", "thorough")).toBeUndefined();
  });

  it("offers no step when Auto's applied rung is unknown, rather than guessing one", () => {
    // Guessing a middle default skips a rung wherever the deployment's default is not the middle
    // one — which is precisely the deployment where the guess would matter.
    expect(nextEffortPreset("auto")).toBeUndefined();
    expect(nextEffortPreset(undefined)).toBeUndefined();
  });

  it("prefers the explicit ask over the applied rung", () => {
    // An applied rung only stands in for `auto`; it never overrides a rung the participant chose.
    expect(nextEffortPreset("fast", "thorough")).toBe("balanced");
  });
});
