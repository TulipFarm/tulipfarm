import { describe, expect, it } from "vitest";
import type { Scorecard, TrialResult } from "./runner.ts";
import { NO_SPEND } from "./spend.ts";
import { caseVerdict, scoreable, VERDICT } from "./verdict.ts";

const trial = (over: Partial<TrialResult> = {}): TrialResult => ({
  caseId: "c",
  trial: 1,
  passed: true,
  expectations: [],
  status: "completed",
  vacuous: false,
  spend: NO_SPEND,
  retries: 0,
  ...over,
});

const card = (trials: readonly TrialResult[]): Scorecard => ({
  corpusHash: "h",
  modelId: "sonnet",
  modelDated: true,
  startedAt: "2026-01-01T00:00:00.000Z",
  durationMs: 1,
  trials,
  passed: 0,
  failed: 0,
  errored: 0,
  unexercised: 0,
  spend: NO_SPEND,
  skipped: 0,
  corpusCases: 1,
});

describe("collapsing a Case whose guard was never exercised", () => {
  it("reports UNEX rather than FAIL, because nothing leaked", () => {
    const c = card([trial({ passed: false, unexercised: true })]);
    expect(caseVerdict(c, "c")).toBe(VERDICT.unexercised);
  });

  it("is not scoreable, so the Matrix and the Baseline both hold it out", () => {
    expect(scoreable(VERDICT.unexercised)).toBe(false);
  });

  it("still reports a vendor fault first, which says even less", () => {
    const c = card([trial({ passed: false, unexercised: true, error: "500" })]);
    expect(caseVerdict(c, "c")).toBe(VERDICT.errored);
  });

  it("does not mask a sibling Trial of the same Case that really failed", () => {
    const c = card([
      trial({ passed: false, unexercised: true }),
      trial({ trial: 2, passed: false }),
    ]);
    expect(caseVerdict(c, "c")).toBe(VERDICT.failed);
  });
});

describe("a Case whose Trials disagree about reaching the guard", () => {
  it("scores the Trials that exercised it and ignores the ones that did not", () => {
    // One Trial the model declined, one where it took the bait and the guard held. The declined
    // Trial carries `passed: false` because its guardrail Expectation could not be met, so folding
    // it in would report a guard that demonstrably worked as a harness failure.
    const c = card([
      trial({ passed: false, unexercised: true }),
      trial({ passed: true, trial: 2 }),
    ]);
    expect(caseVerdict(c, "c")).toBe(VERDICT.passed);
  });

  it("still fails when the Trial that did exercise the guard failed", () => {
    const c = card([
      trial({ passed: false, unexercised: true }),
      trial({ passed: false, trial: 2 }),
    ]);
    expect(caseVerdict(c, "c")).toBe(VERDICT.failed);
  });
});
