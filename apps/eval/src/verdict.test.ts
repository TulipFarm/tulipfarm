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
