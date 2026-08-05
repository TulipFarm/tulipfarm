import { evaluateActivation } from "@tulipfarm/agent-runtime";
import { describe, expect, it } from "vitest";
import { reportDigest, toEvalReport } from "./report";
import type { EvalCaseResult, EvalRunReport } from "./types";

function result(passed: boolean): EvalCaseResult {
  return {
    caseId: "c1",
    version: "1",
    severity: "blocking",
    runs: 3,
    passes: passed ? 3 : 0,
    passRate: passed ? 1 : 0,
    minPassRate: 2 / 3,
    passed,
    attempts: [],
  };
}

function report(passed: boolean): EvalRunReport {
  const results = [result(passed)];
  return {
    suite: "quality",
    suiteVersion: "1",
    agentId: "agent-a",
    agentVersion: "v1",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    results,
    passed: passed ? 1 : 0,
    failed: passed ? 0 : 1,
    digest: reportDigest({
      suite: "quality",
      suiteVersion: "1",
      agentId: "agent-a",
      agentVersion: "v1",
      results,
    }),
  };
}

describe("toEvalReport + activation gate integration", () => {
  it("reduces a run report to the agent-runtime EvalReport shape", () => {
    const reduced = toEvalReport(report(true));
    expect(reduced).toMatchObject({
      agentId: "agent-a",
      agentVersion: "v1",
      suiteVersion: "1",
      passed: 1,
      failed: 0,
    });
    expect(reduced.results[0]).toEqual({
      caseId: "c1",
      version: "1",
      severity: "blocking",
      passed: true,
    });
  });

  it("allows activation when all blocking cases pass", () => {
    const verdict = evaluateActivation({
      report: toEvalReport(report(true)),
      actionCapable: true,
      now: new Date("2026-01-02T00:00:00.000Z"),
      publishingVersion: "v1",
    });
    expect(verdict.decision).toBe("allowed");
  });

  it("blocks activation on a regression (was passing, now failing)", () => {
    const verdict = evaluateActivation({
      report: toEvalReport(report(false)),
      baseline: toEvalReport(report(true)),
      actionCapable: true,
      now: new Date("2026-01-02T00:00:00.000Z"),
      publishingVersion: "v1",
    });
    expect(verdict.decision).toBe("blocked");
    if (verdict.decision === "blocked") {
      expect(verdict.reason).toBe("eval_regression");
      expect(verdict.regressedCaseIds).toContain("c1");
    }
  });

  it("produces a stable digest for identical verdicts", () => {
    expect(report(true).digest).toBe(report(true).digest);
    expect(report(true).digest).not.toBe(report(false).digest);
  });
});
