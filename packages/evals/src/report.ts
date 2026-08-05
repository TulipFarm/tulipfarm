import type { EvalReport } from "@tulipfarm/agent-runtime";
import { canonicalHash } from "@tulipfarm/schema";
import type { EvalCaseResult, EvalRunReport } from "./types";

/**
 * Stable digest of a run report's verdicts. Excludes timing and per-attempt output so re-running
 * the same cases against the same expectations yields the same digest — a regression is a change in
 * pass/fail, not in wall-clock time or an incidental wording difference in the model's prose.
 */
export function reportDigest(input: {
  readonly suite: string;
  readonly suiteVersion: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly results: readonly EvalCaseResult[];
}): string {
  return canonicalHash({
    suite: input.suite,
    suiteVersion: input.suiteVersion,
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    results: input.results.map((result) => ({
      caseId: result.caseId,
      version: result.version,
      severity: result.severity,
      passed: result.passed,
    })),
  });
}

/**
 * Reduce the rich harness report to the agent-runtime `EvalReport` shape consumed by
 * `evaluateActivation`. The publication gate only cares about per-case pass/fail and severity, so a
 * multi-run, multi-scorer result collapses to a single verdict per case here.
 */
export function toEvalReport(report: EvalRunReport): EvalReport {
  const results = report.results.map((result) => ({
    caseId: result.caseId,
    version: result.version,
    severity: result.severity,
    passed: result.passed,
  }));
  return {
    agentId: report.agentId,
    agentVersion: report.agentVersion,
    suiteVersion: report.suiteVersion,
    results,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    digest: report.digest,
  };
}
