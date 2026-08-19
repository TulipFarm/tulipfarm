import { describe, expect, it } from "vitest";
import { asChatAutonomy, autonomyCeiling, autonomyDemandsApproval } from "./autonomy";
import type { ChatAutonomy } from "./types";

const LADDER: readonly ChatAutonomy[] = ["manual", "approval-required", "supervised", "full"];

describe("asChatAutonomy", () => {
  it("accepts every level and nothing else", () => {
    for (const level of LADDER) expect(asChatAutonomy(level)).toBe(level);
    expect(asChatAutonomy("banana")).toBeUndefined();
    expect(asChatAutonomy(undefined)).toBeUndefined();
    expect(asChatAutonomy(7)).toBeUndefined();
    // Prototype keys are not levels; `toString` must not resolve as one.
    expect(asChatAutonomy("toString")).toBeUndefined();
  });
});

describe("autonomyCeiling", () => {
  it("takes the more restrictive of the two across every pairing", () => {
    for (const [ceilingIndex, configured] of LADDER.entries()) {
      for (const [askedIndex, requested] of LADDER.entries()) {
        expect(autonomyCeiling(configured, requested)).toBe(
          LADDER[Math.min(ceilingIndex, askedIndex)]
        );
      }
    }
  });

  it("never lets a per-turn value raise an Agent above its configured ceiling", () => {
    expect(autonomyCeiling("approval-required", "full")).toBe("approval-required");
    expect(autonomyCeiling("manual", "full")).toBe("manual");
    expect(autonomyCeiling("supervised", "full")).toBe("supervised");
  });

  it("lets a per-turn value lower the Agent's ceiling", () => {
    expect(autonomyCeiling("full", "approval-required")).toBe("approval-required");
    expect(autonomyCeiling("supervised", "manual")).toBe("manual");
  });

  it("falls back to whichever side states a level, and to none when neither does", () => {
    expect(autonomyCeiling(undefined, "full")).toBe("full");
    expect(autonomyCeiling("approval-required", undefined)).toBe("approval-required");
    expect(autonomyCeiling(undefined, undefined)).toBeUndefined();
    // An unrecognised value contributes no ceiling rather than a permissive one.
    expect(autonomyCeiling("banana", "manual")).toBe("manual");
    expect(autonomyCeiling("manual", "banana")).toBe("manual");
    expect(autonomyCeiling("banana", "banana")).toBeUndefined();
  });
});

describe("autonomyDemandsApproval", () => {
  it("demands a human only for a mutating Tool under approval-required", () => {
    const mutating = { mutating: true };
    expect(autonomyDemandsApproval(mutating, "approval-required")).toBe(true);
    expect(autonomyDemandsApproval(mutating, "full")).toBe(false);
    expect(autonomyDemandsApproval(mutating, undefined)).toBe(false);
    expect(autonomyDemandsApproval({ mutating: false }, "approval-required")).toBe(false);
  });

  it("honours a Tool that opted out of approval", () => {
    expect(
      autonomyDemandsApproval({ mutating: true, requiresApproval: false }, "approval-required")
    ).toBe(false);
  });
});
