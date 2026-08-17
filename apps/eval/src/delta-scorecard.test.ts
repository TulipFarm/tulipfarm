import { describe, expect, it } from "vitest";
import { compareToBaseline } from "./baseline.ts";
import type { Scorecard, TrialResult } from "./runner.ts";
import { renderDelta } from "./scorecard.ts";
import { NO_SPEND } from "./spend.ts";

function trial(caseId: string, over: Partial<TrialResult> = {}): TrialResult {
  return {
    caseId,
    trial: 1,
    passed: true,
    expectations: [],
    status: "completed",
    vacuous: false,
    spend: NO_SPEND,
    retries: 0,
    ...over,
  };
}

function card(trials: TrialResult[], over: Partial<Scorecard> = {}): Scorecard {
  return {
    corpusHash: "c5b18cdb24359819aa",
    modelId: "sonnet",
    modelDated: false,
    startedAt: "2024-01-01T00:00:00.000Z",
    durationMs: 5,
    trials,
    passed: trials.filter((t) => t.passed && t.error === undefined).length,
    failed: trials.filter((t) => !t.passed && t.error === undefined).length,
    errored: trials.filter((t) => t.error !== undefined).length,
    skipped: 0,
    corpusCases: new Set(trials.map((t) => t.caseId)).size,
    spend: NO_SPEND,
    ...over,
  };
}

const delta = (before: TrialResult[], after: TrialResult[]) =>
  renderDelta(compareToBaseline(card(before), card(after)), "abc1234");

describe("renderDelta", () => {
  it("leads with the model, Corpus and Baseline it is a delta against", () => {
    const out = delta([trial("a")], [trial("a")]);

    expect(out).toContain("model=sonnet");
    expect(out).toContain("corpus=c5b18cdb24359819");
    expect(out).toContain("baseline=abc1234");
  });

  it("names every regressed Case with the change it made", () => {
    const out = delta([trial("a")], [trial("a", { passed: false })]);

    expect(out).toContain("REGRESSED");
    expect(out).toMatch(/a\s+PASS -> FAIL/);
  });

  it("names every fixed Case", () => {
    const out = delta([trial("a", { passed: false })], [trial("a")]);

    expect(out).toContain("FIXED");
    expect(out).toMatch(/a\s+FAIL -> PASS/);
  });

  it("reports the aggregate, so a run is read as a change and not as a score", () => {
    const out = delta([trial("a"), trial("b", { passed: false })], [trial("a"), trial("b")]);

    expect(out).toContain("1 passed before, 2 passed after");
  });

  it("says so plainly when nothing moved, rather than printing an empty report", () => {
    const out = delta([trial("a")], [trial("a")]);

    expect(out).toContain("No change against the Baseline");
    expect(out).not.toContain("REGRESSED");
  });

  it("holds an errored Case out instead of reporting it as a regression", () => {
    const out = delta([trial("a")], [trial("a", { error: "429 rate limited" })]);

    expect(out).not.toContain("REGRESSED");
    expect(out).toContain("NOT COMPARABLE");
    expect(out).toMatch(/a\s+PASS -> ERR/);
  });

  it("marks a Baseline promoted from a dirty tree, because it cannot be reproduced", () => {
    expect(delta([trial("a")], [trial("a")])).not.toContain("not reproducible");
    expect(
      renderDelta(compareToBaseline(card([trial("a")]), card([trial("a")])), "abc-dirty")
    ).toContain("not reproducible");
  });
});
