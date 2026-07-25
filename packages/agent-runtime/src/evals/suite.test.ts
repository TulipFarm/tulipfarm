import { describe, expect, it } from "vitest";
import {
  type EvalCase,
  type EvalCaseResult,
  type EvalReport,
  evaluateActivation,
  runEvalSuite,
} from "./suite";

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    caseId: "triage-1",
    version: "1.0.0",
    severity: "blocking",
    input: { prompt: "classify this ticket" },
    expected: { label: "bug" },
    ...overrides,
  };
}

function result(caseId: string, passed: boolean, version = "1.0.0"): EvalCaseResult {
  return { caseId, version, severity: "blocking", passed };
}

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    agentId: "triage-agent",
    agentVersion: "2.0.0",
    suiteVersion: "1.0.0",
    results: [result("triage-1", true)],
    passed: 1,
    failed: 0,
    digest: "digest",
    ...overrides,
  };
}

const NOW = new Date("2026-07-25T10:00:00.000Z");

describe("runEvalSuite", () => {
  it("records a pass/fail per versioned case and a digest of the whole run", async () => {
    const suiteReport = await runEvalSuite({
      agentId: "triage-agent",
      agentVersion: "2.0.0",
      suiteVersion: "1.0.0",
      cases: [evalCase(), evalCase({ caseId: "triage-2", expected: { label: "question" } })],
      execute: async (testCase) =>
        testCase.caseId === "triage-1" ? { label: "bug" } : { label: "bug" },
    });

    expect(suiteReport.results).toEqual([
      { caseId: "triage-1", version: "1.0.0", severity: "blocking", passed: true },
      { caseId: "triage-2", version: "1.0.0", severity: "blocking", passed: false },
    ]);
    expect(suiteReport).toMatchObject({ passed: 1, failed: 1 });
    expect(suiteReport.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts an execution error as a failed case rather than aborting the suite", async () => {
    const suiteReport = await runEvalSuite({
      agentId: "triage-agent",
      agentVersion: "2.0.0",
      suiteVersion: "1.0.0",
      cases: [evalCase(), evalCase({ caseId: "triage-2" })],
      execute: async (testCase) => {
        if (testCase.caseId === "triage-1") throw new Error("model unavailable");
        return { label: "bug" };
      },
    });

    expect(suiteReport.results.map((entry) => entry.passed)).toEqual([false, true]);
  });

  it("gives the same digest for the same results and a different one when a case changes", async () => {
    const run = (expected: unknown) =>
      runEvalSuite({
        agentId: "triage-agent",
        agentVersion: "2.0.0",
        suiteVersion: "1.0.0",
        cases: [evalCase({ expected })],
        execute: async () => ({ label: "bug" }),
      });

    const first = await run({ label: "bug" });
    const second = await run({ label: "bug" });
    const third = await run({ label: "question" });

    expect(first.digest).toBe(second.digest);
    expect(third.digest).not.toBe(first.digest);
  });
});

describe("evaluateActivation", () => {
  it("activates an action-capable Agent whose blocking cases all pass", () => {
    expect(evaluateActivation({ report: report(), actionCapable: true, now: NOW })).toMatchObject({
      decision: "allowed",
    });
  });

  it("blocks an action-capable Agent on a regression against the baseline", () => {
    const verdict = evaluateActivation({
      report: report({ results: [result("triage-1", false)], passed: 0, failed: 1 }),
      baseline: report(),
      actionCapable: true,
      now: NOW,
    });

    expect(verdict).toMatchObject({ decision: "blocked", reason: "eval_regression" });
    expect(verdict.decision === "blocked" && verdict.regressedCaseIds).toEqual(["triage-1"]);
  });

  it("blocks a failing blocking case even with no baseline to regress against", () => {
    expect(
      evaluateActivation({
        report: report({ results: [result("triage-1", false)], passed: 0, failed: 1 }),
        actionCapable: true,
        now: NOW,
      })
    ).toMatchObject({ decision: "blocked", reason: "blocking_case_failed" });
  });

  it("does not block on an advisory case", () => {
    expect(
      evaluateActivation({
        report: report({
          results: [{ caseId: "style-1", version: "1.0.0", severity: "advisory", passed: false }],
          passed: 0,
          failed: 1,
        }),
        actionCapable: true,
        now: NOW,
      })
    ).toMatchObject({ decision: "allowed" });
  });

  it("allows a read-only Agent to publish while its blocking case fails", () => {
    expect(
      evaluateActivation({
        report: report({ results: [result("triage-1", false)], passed: 0, failed: 1 }),
        baseline: report(),
        actionCapable: false,
        now: NOW,
      })
    ).toMatchObject({ decision: "allowed" });
  });

  it("allows a regression covered by a scoped, unexpired, audited admin exception", () => {
    const verdict = evaluateActivation({
      report: report({ results: [result("triage-1", false)], passed: 0, failed: 1 }),
      baseline: report(),
      actionCapable: true,
      now: NOW,
      exception: {
        exceptionId: "exc-1",
        agentId: "triage-agent",
        caseIds: ["triage-1"],
        grantedBy: "user:admin-1",
        grantedByRole: "admin",
        expiresAt: "2026-07-26T10:00:00.000Z",
        auditEventId: "audit-1",
        reason: "known upstream flake, fix tracked",
      },
    });

    expect(verdict).toMatchObject({ decision: "allowed", exceptionId: "exc-1" });
  });

  it("rejects an expired exception", () => {
    expect(
      evaluateActivation({
        report: report({ results: [result("triage-1", false)], passed: 0, failed: 1 }),
        baseline: report(),
        actionCapable: true,
        now: NOW,
        exception: {
          exceptionId: "exc-1",
          agentId: "triage-agent",
          caseIds: ["triage-1"],
          grantedBy: "user:admin-1",
          grantedByRole: "admin",
          expiresAt: "2026-07-24T10:00:00.000Z",
          auditEventId: "audit-1",
          reason: "stale",
        },
      })
    ).toMatchObject({ decision: "blocked", reason: "eval_regression" });
  });

  it("rejects an exception scoped to another Agent or another case", () => {
    const base = {
      report: report({ results: [result("triage-1", false)], passed: 0, failed: 1 }),
      baseline: report(),
      actionCapable: true,
      now: NOW,
    };
    const exception = {
      exceptionId: "exc-1",
      agentId: "triage-agent",
      caseIds: ["triage-1"],
      grantedBy: "user:admin-1",
      grantedByRole: "admin" as const,
      expiresAt: "2026-07-26T10:00:00.000Z",
      auditEventId: "audit-1",
      reason: "scoped",
    };

    expect(
      evaluateActivation({ ...base, exception: { ...exception, agentId: "other-agent" } })
    ).toMatchObject({ decision: "blocked" });
    expect(
      evaluateActivation({ ...base, exception: { ...exception, caseIds: ["triage-2"] } })
    ).toMatchObject({ decision: "blocked" });
  });

  it("rejects an unaudited or non-admin exception", () => {
    const base = {
      report: report({ results: [result("triage-1", false)], passed: 0, failed: 1 }),
      baseline: report(),
      actionCapable: true,
      now: NOW,
    };
    const exception = {
      exceptionId: "exc-1",
      agentId: "triage-agent",
      caseIds: ["triage-1"],
      grantedBy: "user:admin-1",
      grantedByRole: "admin" as const,
      expiresAt: "2026-07-26T10:00:00.000Z",
      auditEventId: "audit-1",
      reason: "scoped",
    };

    expect(
      evaluateActivation({
        ...base,
        exception: { ...exception, grantedByRole: "member" as unknown as "admin" },
      })
    ).toMatchObject({ decision: "blocked" });
    expect(
      evaluateActivation({ ...base, exception: { ...exception, auditEventId: "" } })
    ).toMatchObject({ decision: "blocked" });
  });

  it("blocks when the report was produced against a different Agent version", () => {
    expect(
      evaluateActivation({
        report: report({ agentVersion: "1.9.0" }),
        actionCapable: true,
        now: NOW,
        publishingVersion: "2.0.0",
      })
    ).toMatchObject({ decision: "blocked", reason: "stale_eval_report" });
  });
});
