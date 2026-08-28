import { describe, expect, it } from "vitest";
import { exceedsRiskCeiling } from "./gate";

/**
 * A Routine State authors `permissionCeiling` to run with less than its owner holds. The compiler
 * refuses a ceiling that escalates, so the only thing left to enforce is the Tool actually called
 * — and nothing did: `state.permissions` was compiled and then read by no runtime path, so an
 * authored `maxRiskClass: "low"` State still reached `api_request`, which declares `high`.
 */
describe("exceedsRiskCeiling", () => {
  it("refuses a Tool more dangerous than the authored ceiling", () => {
    expect(exceedsRiskCeiling("high", { maxRiskClass: "low" })).toBe(true);
    expect(exceedsRiskCeiling("critical", { maxRiskClass: "medium" })).toBe(true);
    expect(exceedsRiskCeiling("medium", { maxRiskClass: "none" })).toBe(true);
  });

  it("allows a Tool at or below the ceiling", () => {
    expect(exceedsRiskCeiling("low", { maxRiskClass: "low" })).toBe(false);
    expect(exceedsRiskCeiling("low", { maxRiskClass: "high" })).toBe(false);
    expect(exceedsRiskCeiling("none", { maxRiskClass: "none" })).toBe(false);
  });

  it("holds the caller to nothing when no ceiling was authored", () => {
    expect(exceedsRiskCeiling("critical", undefined)).toBe(false);
    expect(exceedsRiskCeiling("critical", {})).toBe(false);
  });

  it("treats an unknown risk class as above every ceiling rather than below it", () => {
    // Fail closed: a Tool declaring a class this ladder has never heard of is not "safe by
    // default", or adding a class would silently unenforce every ceiling already authored.
    expect(exceedsRiskCeiling("banana", { maxRiskClass: "critical" })).toBe(true);
    // A ceiling naming an unknown class is the permissive side of the same unknown, so a known
    // class stays below it and the State still runs.
    expect(exceedsRiskCeiling("high", { maxRiskClass: "banana" })).toBe(false);
  });
});
