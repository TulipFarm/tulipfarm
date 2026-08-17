import { describe, expect, it } from "vitest";
import { progressReporter } from "./progress.ts";
import type { TrialResult } from "./runner.ts";
import { NO_SPEND } from "./spend.ts";

const trial = (over: Partial<TrialResult> = {}): TrialResult => ({
  caseId: "a",
  trial: 1,
  status: "completed",
  passed: true,
  vacuous: false,
  retries: 0,
  spend: NO_SPEND,
  expectations: [],
  ...over,
});

function reporter() {
  const out: string[] = [];
  let clock = 0;
  const report = progressReporter(
    (text) => out.push(text),
    () => {
      clock += 1000;
      return clock;
    }
  );
  return { out, report, text: () => out.join("") };
}

describe("progressReporter", () => {
  it("announces the model and the size of the run before anything is called", () => {
    const r = reporter();

    r.report({ kind: "sweep-start", modelId: "sonnet", cases: 2, planned: 3 });

    expect(r.text()).toContain("sonnet  2 Cases, 3 Trials");
  });

  it("names the Case before the call, so a slow Trial is not silence", () => {
    const r = reporter();

    r.report({ kind: "trial-start", caseId: "triage", trial: 2, index: 3, planned: 7 });

    expect(r.out.at(-1)).toBe("  [3/7] triage#2 … ");
    expect(r.out.at(-1)).not.toContain("\n");
  });

  it("closes the line with the verdict and how long it took", () => {
    const r = reporter();

    r.report({ kind: "trial-start", caseId: "a", trial: 1, index: 1, planned: 1 });
    r.report({ kind: "trial-end", result: trial() });

    expect(r.out.at(-1)).toBe("PASS  1.0s\n");
  });

  it("reports a vendor fault as ERR, never as a failing Case", () => {
    const r = reporter();

    r.report({ kind: "trial-end", result: trial({ passed: false, error: "rate limited" }) });

    expect(r.out.at(-1)).toContain("ERR");
    expect(r.out.at(-1)).not.toContain("FAIL");
  });

  it("reports a Case that expected nothing as VAC, not as a pass", () => {
    const r = reporter();

    r.report({ kind: "trial-end", result: trial({ vacuous: true }) });

    expect(r.out.at(-1)).toContain("VAC");
    expect(r.out.at(-1)).not.toContain("PASS");
  });

  it("shows a green Trial that needed retries, which a verdict alone would hide", () => {
    const r = reporter();

    r.report({ kind: "trial-end", result: trial({ retries: 2 }) });

    expect(r.out.at(-1)).toContain("2 retried");
  });

  it("says when the Sweep stopped early rather than leaving the run looking complete", () => {
    const r = reporter();

    r.report({ kind: "sweep-aborted", reason: "token ceiling 20000 reached" });

    expect(r.text()).toContain("stopped early: token ceiling 20000 reached");
  });
});
