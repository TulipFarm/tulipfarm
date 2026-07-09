import { describe, expect, it } from "vitest";
import { parseIsoDuration } from "./duration";

describe("parseIsoDuration", () => {
  it("parses time components", () => {
    expect(parseIsoDuration("PT1S")).toBe(1_000);
    expect(parseIsoDuration("PT10M")).toBe(600_000);
    expect(parseIsoDuration("PT2H")).toBe(7_200_000);
    expect(parseIsoDuration("PT1H30M15S")).toBe(5_415_000);
  });

  it("parses date components", () => {
    expect(parseIsoDuration("P1D")).toBe(86_400_000);
    expect(parseIsoDuration("P1W")).toBe(604_800_000);
    expect(parseIsoDuration("P1DT12H")).toBe(129_600_000);
  });

  it("throws on malformed durations", () => {
    for (const bad of ["", "P", "PT", "10m", "PT5X", "5 minutes"]) {
      expect(() => parseIsoDuration(bad)).toThrow(/invalid ISO-8601/);
    }
  });
});
