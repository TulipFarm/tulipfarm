import { describe, expect, it } from "vitest";
import { BaselineMismatchError, compareToBaseline } from "./baseline.ts";
import type { Scorecard, TrialResult } from "./runner.ts";
import { NO_SPEND } from "./spend.ts";

const trial = (caseId: string, over: Partial<TrialResult> = {}): TrialResult => ({
  caseId,
  trial: 1,
  status: "completed",
  passed: true,
  vacuous: false,
  retries: 0,
  spend: NO_SPEND,
  expectations: [],
  ...over,
});

const card = (trials: TrialResult[], over: Partial<Scorecard> = {}): Scorecard => ({
  corpusHash: "corpus-1",
  modelId: "sonnet",
  modelDated: false,
  startedAt: "2025-01-01T00:00:00.000Z",
  durationMs: 10,
  trials,
  passed: trials.filter((t) => t.passed && t.error === undefined).length,
  failed: trials.filter((t) => !t.passed && t.error === undefined).length,
  errored: trials.filter((t) => t.error !== undefined).length,
  unexercised: 0,
  skipped: 0,
  corpusCases: new Set(trials.map((t) => t.caseId)).size,
  spend: NO_SPEND,
  ...over,
});

describe("compareToBaseline", () => {
  it("reports a Case that now fails as a regression", () => {
    const delta = compareToBaseline(card([trial("a")]), card([trial("a", { passed: false })]));

    expect(delta.regressed).toBe(1);
    expect(delta.fixed).toBe(0);
    expect(delta.cases[0]).toMatchObject({ caseId: "a", change: "regressed" });
  });

  it("reports a Case that now passes as fixed", () => {
    const delta = compareToBaseline(card([trial("a", { passed: false })]), card([trial("a")]));

    expect(delta.fixed).toBe(1);
    expect(delta.regressed).toBe(0);
  });

  it("reports an unchanged Case as unchanged, which is most of them", () => {
    const delta = compareToBaseline(card([trial("a")]), card([trial("a")]));

    expect(delta.cases[0]?.change).toBe("unchanged");
    expect(delta.regressed + delta.fixed).toBe(0);
  });

  it("refuses to compare Scorecards from different Corpora", () => {
    expect(() =>
      compareToBaseline(card([trial("a")]), card([trial("a")], { corpusHash: "corpus-2" }))
    ).toThrow(BaselineMismatchError);
  });

  it("names both hashes when it refuses, so the mismatch can be resolved", () => {
    expect(() =>
      compareToBaseline(card([trial("a")]), card([trial("a")], { corpusHash: "corpus-2" }))
    ).toThrow(/corpus-1.*corpus-2/s);
  });

  it("refuses to compare one model against another", () => {
    expect(() =>
      compareToBaseline(card([trial("a")]), card([trial("a")], { modelId: "terra" }))
    ).toThrow(BaselineMismatchError);
  });

  it("does not call a vendor error a regression", () => {
    const delta = compareToBaseline(
      card([trial("a")]),
      card([trial("a", { passed: false, error: "rate limited" })])
    );

    expect(delta.regressed).toBe(0);
    expect(delta.cases[0]?.change).toBe("not-comparable");
  });

  it("does not call a Case the Sweep never reached a regression", () => {
    const delta = compareToBaseline(card([trial("a"), trial("b")]), card([trial("a")]));

    expect(delta.regressed).toBe(0);
    expect(delta.cases.find((c) => c.caseId === "b")?.change).toBe("not-comparable");
  });

  it("does not call a Case the Baseline never measured an improvement", () => {
    const delta = compareToBaseline(card([trial("a")]), card([trial("a"), trial("b")]));

    expect(delta.fixed).toBe(0);
    expect(delta.cases.find((c) => c.caseId === "b")).toMatchObject({
      change: "not-comparable",
      before: "-",
    });
  });

  it("counts passes on both sides so the aggregate move is visible", () => {
    const delta = compareToBaseline(
      card([trial("a"), trial("b", { passed: false })]),
      card([trial("a"), trial("b")])
    );

    expect(delta.passedBefore).toBe(1);
    expect(delta.passedAfter).toBe(2);
  });

  it("keeps both verdicts on every Case, so a reader need not hold the Baseline open", () => {
    const delta = compareToBaseline(card([trial("a")]), card([trial("a", { passed: false })]));

    expect(delta.cases[0]).toMatchObject({ before: "PASS", after: "FAIL" });
  });
});

describe("damping a delta against the Baseline's noise floor", () => {
  const fails = (id: string) => trial(id, { passed: false });
  const withFloor = (base: Scorecard, flapping: string[]): Scorecard => ({
    ...base,
    noise: { repeats: 3, flapping, measured: flapping.length },
  });

  it("reports a movement on a Case the Baseline saw flap as no signal", () => {
    const before = withFloor(card([trial("flappy")]), ["flappy"]);

    const delta = compareToBaseline(before, card([fails("flappy")]));

    expect(delta.cases[0]?.change).toBe("no-signal");
    expect(delta.regressed).toBe(0);
    expect(delta.noSignal).toBe(1);
  });

  it("still reports a regression on a Case that never flapped", () => {
    const before = withFloor(card([trial("steady"), trial("flappy")]), ["flappy"]);

    const delta = compareToBaseline(before, card([fails("steady"), fails("flappy")]));

    expect(delta.regressed).toBe(1);
    expect(delta.noSignal).toBe(1);
    expect(delta.cases.find((c) => c.caseId === "steady")?.change).toBe("regressed");
  });

  it("damps nothing when the Baseline never measured a floor", () => {
    const delta = compareToBaseline(card([trial("a")]), card([fails("a")]));

    expect(delta.regressed).toBe(1);
    expect(delta.noSignal).toBe(0);
    expect(delta.floor).toBeUndefined();
  });

  it("damps a fix as readily as a regression, so noise cannot be claimed as progress", () => {
    const before = withFloor(card([fails("flappy")]), ["flappy"]);

    const delta = compareToBaseline(before, card([trial("flappy")]));

    expect(delta.fixed).toBe(0);
    expect(delta.noSignal).toBe(1);
  });
});
