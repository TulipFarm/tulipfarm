import { describe, expect, it } from "vitest";
import { LimitError } from "../limits";
import { mapAuthoredLimits } from "./authored-limits";

describe("mapAuthoredLimits", () => {
  it("renames the three keys the runtime spells differently", () => {
    expect(mapAuthoredLimits({ wallClockMs: 60_000, activeMs: 30_000 })).toEqual({
      wallTimeMs: 60_000,
      activeTimeMs: 30_000,
    });
  });

  it("converts an authored USD cost ceiling up into micro-USD", () => {
    expect(mapAuthoredLimits({ costUsd: 5 })).toEqual({ costMicros: 5_000_000 });
    expect(mapAuthoredLimits({ costUsd: 0.25 })).toEqual({ costMicros: 250_000 });
    expect(mapAuthoredLimits({ costUsd: 0 })).toEqual({ costMicros: 0 });
  });

  it("keeps a positive fractional cost ceiling above zero", () => {
    expect(mapAuthoredLimits({ costUsd: 0.0000001 })).toEqual({ costMicros: 1 });
  });

  it("passes the eight identically spelled keys through unchanged", () => {
    const authored = {
      tokens: 1_000,
      iterations: 5,
      fanOut: 3,
      parallelism: 2,
      artifactBytes: 4_096,
      resultRows: 100,
      networkBytes: 8_192,
      sideEffects: 0,
    };
    expect(mapAuthoredLimits(authored)).toEqual(authored);
  });

  it("maps an empty block to an empty set rather than inventing defaults", () => {
    expect(mapAuthoredLimits({})).toEqual({});
  });

  it("refuses a key it cannot map instead of dropping it", () => {
    expect(() => mapAuthoredLimits({ wallTimeMs: 60_000 })).toThrow(LimitError);
    expect(() => mapAuthoredLimits({ wallTimeMs: 60_000 })).toThrow("invalid_limit:wallTimeMs");
  });

  it("refuses values the runtime cannot enforce", () => {
    expect(() => mapAuthoredLimits({ tokens: -1 })).toThrow("invalid_limit:tokens");
    expect(() => mapAuthoredLimits({ tokens: Number.NaN })).toThrow("invalid_limit:tokens");
    expect(() => mapAuthoredLimits({ tokens: "10" })).toThrow("invalid_limit:tokens");
    expect(() => mapAuthoredLimits({ wallClockMs: 1.5 })).toThrow("invalid_limit:wallTimeMs");
  });
});
