import { describe, expect, it } from "vitest";
import { measureNoise, noiseBand } from "./noise.ts";
import type { Scorecard, TrialResult } from "./runner.ts";
import { NO_SPEND } from "./spend.ts";

function trial(caseId: string, n: number, passed: boolean, over: Partial<TrialResult> = {}) {
  return {
    caseId,
    trial: n,
    passed,
    expectations: [],
    status: passed ? ("passed" as const) : ("failed" as const),
    vacuous: false,
    spend: NO_SPEND,
    retries: 0,
    ...over,
  } satisfies TrialResult;
}

function card(trials: TrialResult[]): Scorecard {
  return {
    corpusHash: "h",
    modelId: "sonnet",
    modelDated: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    trials,
    passed: trials.filter((t) => t.passed).length,
    failed: trials.filter((t) => !t.passed && t.error === undefined).length,
    errored: trials.filter((t) => t.error !== undefined).length,
    spend: NO_SPEND,
    skipped: 0,
    corpusCases: new Set(trials.map((t) => t.caseId)).size,
  };
}

describe("measureNoise", () => {
  it("measures nothing from a Sweep that ran each Case once", () => {
    expect(measureNoise(card([trial("a", 1, true), trial("b", 1, false)]))).toBeUndefined();
  });

  it("reports a Corpus whose repeated Trials all agreed as a floor of zero", () => {
    const floor = measureNoise(card([trial("a", 1, true), trial("a", 2, true)]));

    expect(floor).toEqual({ repeats: 2, flapping: [], measured: 1 });
    expect(noiseBand(floor)).toBe(0);
  });

  it("names the Case whose own Trials disagreed", () => {
    const floor = measureNoise(
      card([
        trial("steady", 1, true),
        trial("steady", 2, true),
        trial("flappy", 1, true),
        trial("flappy", 2, false),
      ])
    );

    expect(floor?.flapping).toEqual(["flappy"]);
    expect(noiseBand(floor)).toBe(1);
  });

  it("holds a Case out of the floor when a vendor fault took one of its Trials", () => {
    // An ERR Trial is not a disagreement about the harness, so a Case that errored once and
    // passed once is not evidence of noise — it is evidence of one vendor call dying.
    const floor = measureNoise(
      card([trial("a", 1, true), trial("a", 2, false, { error: "429 rate limited" })])
    );

    expect(floor).toEqual({ repeats: 2, flapping: [], measured: 0 });
  });

  it("reports the smallest repeat count, so a partial Sweep cannot overstate its floor", () => {
    const floor = measureNoise(
      card([trial("a", 1, true), trial("a", 2, true), trial("a", 3, true), trial("b", 1, true)])
    );

    expect(floor?.repeats).toBe(1);
    expect(floor?.measured).toBe(1);
  });

  it("treats a vacuous Trial as unmeasurable rather than as agreement", () => {
    const floor = measureNoise(
      card([trial("a", 1, true, { vacuous: true }), trial("a", 2, true, { vacuous: true })])
    );

    expect(floor).toEqual({ repeats: 2, flapping: [], measured: 0 });
  });
});

describe("noiseBand", () => {
  it("is zero when no floor was ever measured, so nothing is excused as noise", () => {
    expect(noiseBand(undefined)).toBe(0);
  });
});

describe("what the floor refuses to count", () => {
  it("holds probabilistic red-team Trials out, so resistance is not read as noise", () => {
    const floor = measureNoise(
      card([
        trial("attack", 1, true, { probabilistic: true }),
        trial("attack", 2, false, { probabilistic: true }),
        trial("plain", 1, true),
        trial("plain", 2, true),
      ])
    );

    expect(floor).toEqual({ repeats: 2, flapping: [], measured: 1 });
  });
});
