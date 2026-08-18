import { describe, expect, it } from "vitest";
import type { Matrix } from "./matrix.ts";
import type { Scorecard, TrialResult } from "./runner.ts";
import { renderMatrix } from "./scorecard.ts";
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

const card = (
  modelId: string,
  trials: TrialResult[],
  over: Partial<Scorecard> = {}
): Scorecard => ({
  corpusHash: "abcdef0123456789",
  modelId,
  modelDated: false,
  startedAt: "2025-01-01T00:00:00.000Z",
  durationMs: 10,
  trials,
  passed: trials.filter((t) => t.passed).length,
  failed: trials.filter((t) => !t.passed).length,
  errored: 0,
  unexercised: 0,
  skipped: 0,
  corpusCases: 1,
  spend: NO_SPEND,
  ...over,
});

const matrix = (runs: Matrix["runs"]): Matrix => ({
  corpusHash: "abcdef0123456789cafe",
  startedAt: "2025-01-01T00:00:00.000Z",
  durationMs: 100,
  runs,
});

describe("renderMatrix", () => {
  it("shows one Corpus measured by every model, so neither column can be read alone", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a"), trial("b")]) },
        { modelId: "terra", card: card("terra", [trial("a"), trial("b")]) },
      ])
    );

    expect(out).toContain("corpus=abcdef0123456789");
    expect(out).toMatch(/Case\s+sonnet\s+terra/);
    expect(out).toMatch(/a\s+PASS\s+PASS/);
  });

  it("names the Cases the models disagree on, which is the whole point of a second model", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a"), trial("b")]) },
        {
          modelId: "terra",
          card: card("terra", [trial("a"), trial("b", { passed: false })]),
        },
      ])
    );

    expect(out).toContain("DISAGREEMENT");
    expect(out).toMatch(/b\s+sonnet=PASS\s+terra=FAIL/);
  });

  it("refuses the ranking reading in words, not only by omission", () => {
    // The failure mode is a reader treating the two columns as a scoreboard. Nothing about a
    // grid prevents that on its own, so the Matrix says what it is for.
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a")]) },
        { modelId: "terra", card: card("terra", [trial("a", { passed: false })]) },
      ])
    );

    expect(out).toMatch(/control on the (measurement|harness)/i);
    expect(out).toMatch(/not (competitors|a ranking)/i);
  });

  it("says so when the models agreed, rather than leaving silence to be read as agreement", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a")]) },
        { modelId: "terra", card: card("terra", [trial("a")]) },
      ])
    );

    expect(out).toMatch(/agree/i);
    expect(out).not.toContain("DISAGREEMENT");
  });

  it("marks a model that could not be measured, and does not score it as a failure", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a")]) },
        { modelId: "terra", unavailable: "CODEX_AUTH_JSON is not set" },
      ])
    );

    expect(out).toMatch(/a\s+PASS\s+n\/a/);
    expect(out).toContain("CODEX_AUTH_JSON is not set");
    expect(out).not.toContain("DISAGREEMENT");
  });

  it("distinguishes an errored Case from a failed one in the grid", () => {
    const out = renderMatrix(
      matrix([
        {
          modelId: "sonnet",
          card: card("sonnet", [trial("a", { passed: false, error: "vendor died" })], {
            errored: 1,
            unexercised: 0,
            failed: 0,
            passed: 0,
          }),
        },
      ])
    );

    expect(out).toMatch(/a\s+ERR/);
  });

  it("marks a Case that passed while checking nothing", () => {
    const out = renderMatrix(
      matrix([{ modelId: "sonnet", card: card("sonnet", [trial("a", { vacuous: true })]) }])
    );

    expect(out).toMatch(/a\s+VAC/);
  });

  it("keeps each model's own detail, so a failure is still debuggable", () => {
    const out = renderMatrix(
      matrix([
        {
          modelId: "sonnet",
          card: card("sonnet", [
            trial("a", {
              passed: false,
              expectations: [
                {
                  expectation: { kind: "output_contains", text: "refund" },
                  passed: false,
                  detail: "output does not contain it",
                },
              ],
            }),
          ]),
        },
      ])
    );

    expect(out).toContain("output_contains: output does not contain it");
  });

  it("reports each model's spend on its own, never pooled", () => {
    const out = renderMatrix(
      matrix([
        {
          modelId: "sonnet",
          card: card("sonnet", [trial("a")], {
            spend: { ...NO_SPEND, calls: 1, inputTokens: 100, outputTokens: 10 },
          }),
        },
        {
          modelId: "terra",
          card: card("terra", [trial("a")], {
            spend: { ...NO_SPEND, calls: 1, inputTokens: 700, outputTokens: 70 },
          }),
        },
      ])
    );

    expect(out).toContain("100 in");
    expect(out).toContain("700 in");
    expect(out).not.toContain("800 in");
  });

  it("does not call a vendor error a disagreement — that is the confound it exists to remove", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a"), trial("b")]) },
        {
          modelId: "terra",
          card: card("terra", [trial("a"), trial("b", { passed: false, error: "rate limited" })], {
            errored: 1,
            unexercised: 0,
            failed: 0,
          }),
        },
      ])
    );

    expect(out).not.toContain("DISAGREEMENT");
    expect(out).toContain("NOT COMPARABLE");
    expect(out).toMatch(/b\s+sonnet=PASS\s+terra=ERR/);
  });

  it("does not call a Case one model never reached a disagreement", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a"), trial("b")]) },
        { modelId: "terra", card: card("terra", [trial("a")], { skipped: 1 }) },
      ])
    );

    expect(out).not.toContain("DISAGREEMENT");
    expect(out).toContain("NOT COMPARABLE");
    expect(out).toMatch(/b\s+sonnet=PASS\s+terra=-/);
  });

  it("counts the agreement over the Cases that were comparable, not over the whole Corpus", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a"), trial("b"), trial("c")]) },
        {
          modelId: "terra",
          card: card("terra", [trial("a"), trial("b", { passed: false, error: "vendor died" })], {
            errored: 1,
            unexercised: 0,
            failed: 0,
            skipped: 1,
            corpusCases: 2,
          }),
        },
      ])
    );

    expect(out).toContain("agree on all 1 comparable Case");
    expect(out).toContain("NOT COMPARABLE  2 of 3 Cases");
  });

  it("still reports a real disagreement alongside Cases that could not be compared", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [trial("a"), trial("b")]) },
        {
          modelId: "terra",
          card: card("terra", [trial("a", { passed: false }), trial("b", { error: "boom" })], {
            errored: 1,
            unexercised: 0,
            failed: 1,
          }),
        },
      ])
    );

    expect(out).toContain("DISAGREEMENT  1 of 1 comparable Case");
    expect(out).toMatch(/a\s+sonnet=PASS\s+terra=FAIL/);
    expect(out).toContain("NOT COMPARABLE  1 of 2 Cases");
  });

  it("does not print a header over an empty grid when nothing was measured", () => {
    const out = renderMatrix(matrix([{ modelId: "terra", unavailable: "codex login required" }]));

    expect(out).toContain("1 model  ");
    expect(out).toContain("No Case was measured");
    expect(out).not.toMatch(/Case\s+terra\n/);
    expect(out).toContain("codex login required");
  });
});

describe("a guard one model exercised and another did not", () => {
  const unex = (id: string) => trial(id, { passed: false, unexercised: true });

  it("reports the guard as covered by the Matrix, because some model did attempt it", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [unex("refund")], { unexercised: 1 }) },
        { modelId: "terra", card: card("terra", [trial("refund")]) },
      ])
    );

    expect(out).toContain("GUARD COVERED");
    expect(out).toMatch(/refund\s+exercised on terra/);
  });

  it("does not call that a disagreement, because UNEX is not a verdict", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [unex("refund")], { unexercised: 1 }) },
        { modelId: "terra", card: card("terra", [trial("refund")]) },
      ])
    );

    expect(out).not.toContain("DISAGREEMENT");
  });

  it("reports a guard no model exercised as an uncovered gap instead", () => {
    const out = renderMatrix(
      matrix([
        { modelId: "sonnet", card: card("sonnet", [unex("refund")], { unexercised: 1 }) },
        { modelId: "terra", card: card("terra", [unex("refund")], { unexercised: 1 }) },
      ])
    );

    expect(out).toContain("GUARD UNCOVERED");
    expect(out).not.toContain("GUARD COVERED");
  });
});
