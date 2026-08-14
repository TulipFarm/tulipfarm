import { canonicalHash } from "@tulipfarm/schema";

/** Activation requires passing blocking evals or a scoped, expiring admin exception. */

export type EvalSeverity = "blocking" | "advisory";

export interface EvalCase {
  readonly caseId: string;
  /** Cases are versioned: changing expectations produces a new version, never a silent edit. */
  readonly version: string;
  readonly severity: EvalSeverity;
  readonly input: unknown;
  readonly expected: unknown;
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly version: string;
  readonly severity: EvalSeverity;
  readonly passed: boolean;
}

export interface EvalReport {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly suiteVersion: string;
  readonly results: readonly EvalCaseResult[];
  readonly passed: number;
  readonly failed: number;
  readonly digest: string;
}

export interface RunEvalSuiteInput {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly suiteVersion: string;
  readonly cases: readonly EvalCase[];
  execute(testCase: EvalCase): Promise<unknown>;
  /** Defaults to canonical-digest equality against `expected`. */
  matches?(testCase: EvalCase, actual: unknown): boolean;
}

export async function runEvalSuite(input: RunEvalSuiteInput): Promise<EvalReport> {
  const matches =
    input.matches ??
    ((testCase: EvalCase, actual: unknown) =>
      canonicalHash(testCase.expected) === canonicalHash(actual));

  const results: EvalCaseResult[] = [];
  for (const testCase of input.cases) {
    let passed: boolean;
    try {
      passed = matches(testCase, await input.execute(testCase));
    } catch {
      // An Agent that cannot answer a case has not passed it.
      passed = false;
    }
    results.push({
      caseId: testCase.caseId,
      version: testCase.version,
      severity: testCase.severity,
      passed,
    });
  }

  return {
    agentId: input.agentId,
    agentVersion: input.agentVersion,
    suiteVersion: input.suiteVersion,
    results,
    passed: results.filter((entry) => entry.passed).length,
    failed: results.filter((entry) => !entry.passed).length,
    digest: canonicalHash({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      suiteVersion: input.suiteVersion,
      cases: input.cases.map((testCase) => ({
        caseId: testCase.caseId,
        version: testCase.version,
        expected: testCase.expected,
      })),
      results,
    }),
  };
}

/** Named, expiring, audited admin permission to activate over a specific regression. */
export interface EvalException {
  readonly exceptionId: string;
  readonly agentId: string;
  readonly caseIds: readonly string[];
  readonly grantedBy: string;
  readonly grantedByRole: "admin";
  readonly expiresAt: string;
  readonly auditEventId: string;
  readonly reason: string;
}

export type ActivationBlockReason =
  | "eval_regression"
  | "blocking_case_failed"
  | "stale_eval_report";

export type ActivationVerdict =
  | { readonly decision: "allowed"; readonly exceptionId?: string }
  | {
      readonly decision: "blocked";
      readonly reason: ActivationBlockReason;
      readonly regressedCaseIds: readonly string[];
      readonly failedCaseIds: readonly string[];
    };

export interface EvaluateActivationInput {
  readonly report: EvalReport;
  readonly baseline?: EvalReport;
  readonly actionCapable: boolean;
  readonly now: Date;
  /** Version being published; a report for a different version is stale evidence. */
  readonly publishingVersion?: string;
  readonly exception?: EvalException;
}

export function evaluateActivation(input: EvaluateActivationInput): ActivationVerdict {
  if (
    input.publishingVersion !== undefined &&
    input.publishingVersion !== input.report.agentVersion
  ) {
    return blocked("stale_eval_report", [], []);
  }

  const failed = input.report.results.filter(
    (entry) => !entry.passed && entry.severity === "blocking"
  );
  if (failed.length === 0) return { decision: "allowed" };

  // A read-only Agent cannot act on a wrong answer, so its evals inform rather than gate.
  if (!input.actionCapable) return { decision: "allowed" };

  const baselinePassed = new Set(
    (input.baseline?.results ?? []).filter((entry) => entry.passed).map((entry) => entry.caseId)
  );
  const regressed = failed.filter((entry) => baselinePassed.has(entry.caseId));
  const failedCaseIds = failed.map((entry) => entry.caseId);
  const regressedCaseIds = regressed.map((entry) => entry.caseId);

  if (regressed.length === 0) {
    return blocked("blocking_case_failed", regressedCaseIds, failedCaseIds);
  }

  const exception = input.exception;
  const covered =
    exception !== undefined &&
    exception.agentId === input.report.agentId &&
    exception.grantedByRole === "admin" &&
    exception.auditEventId !== "" &&
    exception.grantedBy !== "" &&
    Date.parse(exception.expiresAt) > input.now.getTime() &&
    failedCaseIds.every((caseId) => exception.caseIds.includes(caseId));

  if (covered && exception !== undefined) {
    return { decision: "allowed", exceptionId: exception.exceptionId };
  }
  return blocked("eval_regression", regressedCaseIds, failedCaseIds);
}

function blocked(
  reason: ActivationBlockReason,
  regressedCaseIds: readonly string[],
  failedCaseIds: readonly string[]
): ActivationVerdict {
  return { decision: "blocked", reason, regressedCaseIds, failedCaseIds };
}
