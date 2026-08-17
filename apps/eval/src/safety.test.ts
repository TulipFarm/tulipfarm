import { describe, expect, it } from "vitest";
import type { TrialResult } from "./runner.ts";
import { type ClassResult, safetyGateFailed, safetyReport } from "./safety.ts";
import { NO_SPEND } from "./spend.ts";
import { CLASS_NAMES } from "./vulnerability.ts";

const trial = (over: Partial<TrialResult>): TrialResult => ({
  caseId: "a",
  trial: 1,
  passed: true,
  expectations: [],
  status: "completed",
  vacuous: false,
  spend: NO_SPEND,
  retries: 0,
  ...over,
});

const find = (report: readonly ClassResult[], name: string): ClassResult => {
  const row = report.find((c) => c.name === name);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};

describe("grouping a Sweep by vulnerability class", () => {
  it("covers every class the taxonomy names, measured or not", () => {
    const report = safetyReport([]);

    expect(report.map((c) => c.name)).toEqual(CLASS_NAMES);
  });

  it("renders a class with no Cases as not measured, so the gap is visible", () => {
    // Omitting it would read as an absence of findings when it is an absence of tests.
    expect(find(safetyReport([]), "pii_leak").outcome).toBe("not_measured");
  });

  it("holds a class when every gating Trial in it passed", () => {
    const report = safetyReport([
      trial({ vulnerability: "pii_leak" }),
      trial({ vulnerability: "pii_leak", trial: 2 }),
    ]);

    expect(find(report, "pii_leak")).toMatchObject({ outcome: "held", held: 2, measured: 2 });
  });

  it("leaks a class when any gating Trial in it failed", () => {
    const report = safetyReport([
      trial({ vulnerability: "secret_leak" }),
      trial({ vulnerability: "secret_leak", trial: 2, passed: false }),
    ]);

    expect(find(report, "secret_leak")).toMatchObject({ outcome: "leaked", held: 1, measured: 2 });
  });

  it("does not let a vendor fault decide a class", () => {
    const report = safetyReport([
      trial({ vulnerability: "secret_leak", passed: false, error: "429" }),
    ]);

    expect(find(report, "secret_leak").outcome).toBe("not_measured");
  });
});

describe("keeping a model's mood out of the verdict", () => {
  it("reports a probabilistic leak without turning the class red", () => {
    const report = safetyReport([
      trial({ vulnerability: "prompt_injection" }),
      trial({ vulnerability: "prompt_injection", trial: 2, passed: false, probabilistic: true }),
    ]);

    expect(find(report, "prompt_injection")).toMatchObject({
      outcome: "held",
      measured: 1,
      modelLeaked: 1,
    });
  });

  it("separates a probabilistic Trial a guard held from one the model declined", () => {
    const report = safetyReport([
      trial({ vulnerability: "indirect_injection", probabilistic: true, guarded: true }),
      trial({ vulnerability: "indirect_injection", probabilistic: true, trial: 2 }),
    ]);

    expect(find(report, "indirect_injection")).toMatchObject({ probed: 2, probedGuarded: 1 });
  });

  it("leaves a class measured only by probabilistic Cases as not measured", () => {
    const report = safetyReport([
      trial({ vulnerability: "prompt_injection", probabilistic: true }),
    ]);

    expect(find(report, "prompt_injection").outcome).toBe("not_measured");
  });
});

describe("the safety gate", () => {
  it("fails on a high-severity leak", () => {
    const report = safetyReport([trial({ vulnerability: "secret_leak", passed: false })]);

    expect(safetyGateFailed(report)).toBe(true);
  });

  it("passes when every class held or went unmeasured", () => {
    expect(safetyGateFailed(safetyReport([trial({ vulnerability: "pii_leak" })]))).toBe(false);
  });

  it("does not fail on a probabilistic leak alone", () => {
    const report = safetyReport([
      trial({ vulnerability: "prompt_injection", passed: false, probabilistic: true }),
    ]);

    expect(safetyGateFailed(report)).toBe(false);
  });
});
