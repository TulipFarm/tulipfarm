import { describe, expect, it } from "vitest";
import type { Scorecard, TrialResult } from "./runner.ts";
import { renderScorecard } from "./scorecard.ts";
import { NO_SPEND } from "./spend.ts";

const trial = (over: Partial<TrialResult> = {}): TrialResult => ({
  caseId: "support-answers-without-tools",
  trial: 1,
  status: "completed",
  passed: true,
  vacuous: false,
  retries: 0,
  spend: { ...NO_SPEND, calls: 1, inputTokens: 100, outputTokens: 20, subscription: 1 },
  expectations: [],
  ...over,
});

const card = (over: Partial<Scorecard> = {}): Scorecard => ({
  modelId: "sonnet",
  modelDated: false,
  corpusHash: "abcdef0123456789deadbeef",
  startedAt: "2025-01-01T00:00:00.000Z",
  durationMs: 1234,
  passed: 1,
  failed: 0,
  errored: 0,
  unexercised: 0,
  skipped: 0,
  corpusCases: 1,
  trials: [trial()],
  spend: { ...NO_SPEND, calls: 1, inputTokens: 100, outputTokens: 20, subscription: 1 },
  ...over,
});

describe("renderScorecard", () => {
  it("leads with what was measured, so two Scorecards cannot be compared blind", () => {
    const out = renderScorecard(card({ effort: "balanced" }));

    expect(out).toContain("model=sonnet");
    expect(out).toContain("corpus=abcdef0123456789");
    expect(out).toContain("effort=balanced");
  });

  it("warns that an alias may have moved under the Sweep", () => {
    // The confound this framework exists to remove is attributing a vendor's change to the
    // harness. With no dated id available, the warning is the only defence left.
    expect(renderScorecard(card())).toContain("is a vendor alias, not a dated pin");
  });

  it("says nothing about drift when the pin is dated", () => {
    expect(renderScorecard(card({ modelDated: true }))).not.toContain("vendor alias");
  });

  it("prints a version only when one was actually reported", () => {
    expect(renderScorecard(card())).not.toContain("version=");
    expect(renderScorecard(card({ modelVersion: "claude-sonnet-4-6-20250219" }))).toContain(
      "version=claude-sonnet-4-6-20250219"
    );
  });

  it("marks an understated total as a floor rather than a figure", () => {
    // An unpriced call cost real money and contributed $0. Printing a bare total would report a
    // smaller bill than was paid.
    const out = renderScorecard(
      card({
        spend: {
          ...NO_SPEND,
          calls: 3,
          inputTokens: 300,
          outputTokens: 60,
          costUsd: 0.02,
          unpriced: 1,
        },
      })
    );

    expect(out).toContain("$0.0200+");
    expect(out).toContain("1 unpriced");
  });

  it("reports a short Sweep as short, not as a clean result", () => {
    const out = renderScorecard(
      card({ skipped: 7, abortedReason: "token ceiling reached: 21000 of 20000 tokens" })
    );

    expect(out).toContain("7 never run");
    expect(out).toContain("ABORTED  token ceiling reached");
  });

  it("shows a retried Trial as retried, because a throttled run is weaker evidence", () => {
    expect(renderScorecard(card({ trials: [trial({ retries: 2 })] }))).toContain("(2 retried)");
  });

  it("explains a failure by naming the Expectation that did not hold", () => {
    const out = renderScorecard(
      card({
        passed: 0,
        failed: 1,
        trials: [
          trial({
            passed: false,
            expectations: [
              {
                expectation: { kind: "output_contains", text: "refund" },
                passed: false,
                detail: "output did not contain \u201crefund\u201d",
              },
            ],
          }),
        ],
      })
    );

    expect(out).toContain("FAIL support-answers-without-tools#1");
    expect(out).toContain("- output_contains: output did not contain");
  });
});
