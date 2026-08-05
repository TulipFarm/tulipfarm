import { reportDigest } from "./report";
import type { EvalTarget } from "./targets";
import type {
  EvalCase,
  EvalCaseResult,
  EvalReportSink,
  EvalRunReport,
  RunAttempt,
  Score,
  Scorer,
} from "./types";

/** Default samples per case. Real models vary, so one lucky/unlucky draw must not decide a verdict. */
export const DEFAULT_RUNS = 3;
/** Default share of runs that must pass for a case to pass (2 of 3). */
export const DEFAULT_MIN_PASS_RATE = 2 / 3;

export interface RunEvalsInput {
  readonly suite: string;
  readonly suiteVersion: string;
  /** Identity carried into the report; `agentId`/`agentVersion` feed the activation gate. */
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly cases: readonly EvalCase[];
  readonly target: EvalTarget;
  readonly scorers: readonly Scorer[];
  readonly runs?: number;
  readonly minPassRate?: number;
  readonly sink?: EvalReportSink;
  now?(): Date;
}

/**
 * Execute a suite against a target.
 *
 * Each case is run `runs` times; every run is scored by all scorers and passes only if every scorer
 * passes; the case passes when the pass rate meets `minPassRate`. This is the multi-run threshold
 * that keeps a nondeterministic-but-healthy agent from flaking, while still catching a real drop in
 * quality. The report is written to `sink` when provided and always returned.
 */
export async function runEvals(input: RunEvalsInput): Promise<EvalRunReport> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const suiteRuns = input.runs ?? DEFAULT_RUNS;
  const suiteMinPassRate = input.minPassRate ?? DEFAULT_MIN_PASS_RATE;

  const results: EvalCaseResult[] = [];
  for (const evalCase of input.cases) {
    results.push(
      await runCase({
        evalCase,
        target: input.target,
        scorers: input.scorers,
        runs: evalCase.runs ?? suiteRuns,
        minPassRate: evalCase.minPassRate ?? suiteMinPassRate,
      })
    );
  }

  const agentId = input.agentId ?? input.suite;
  const agentVersion = input.agentVersion ?? input.suiteVersion;
  const report: EvalRunReport = {
    suite: input.suite,
    suiteVersion: input.suiteVersion,
    agentId,
    agentVersion,
    startedAt,
    finishedAt: now().toISOString(),
    results,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    digest: reportDigest({
      suite: input.suite,
      suiteVersion: input.suiteVersion,
      agentId,
      agentVersion,
      results,
    }),
  };

  await input.sink?.write(report);
  return report;
}

async function runCase(args: {
  readonly evalCase: EvalCase;
  readonly target: EvalTarget;
  readonly scorers: readonly Scorer[];
  readonly runs: number;
  readonly minPassRate: number;
}): Promise<EvalCaseResult> {
  const attempts: RunAttempt[] = [];
  for (let index = 0; index < args.runs; index += 1) {
    attempts.push(await runAttempt({ ...args, index }));
  }
  const passes = attempts.filter((attempt) => attempt.passed).length;
  const passRate = args.runs === 0 ? 0 : passes / args.runs;
  return {
    caseId: args.evalCase.caseId,
    version: args.evalCase.version,
    severity: args.evalCase.severity,
    runs: args.runs,
    passes,
    passRate,
    minPassRate: args.minPassRate,
    passed: passRate >= args.minPassRate,
    attempts,
  };
}

async function runAttempt(args: {
  readonly evalCase: EvalCase;
  readonly target: EvalTarget;
  readonly scorers: readonly Scorer[];
  readonly index: number;
}): Promise<RunAttempt> {
  const startedAt = Date.now();
  let output: Awaited<ReturnType<EvalTarget["execute"]>>;
  try {
    output = await args.target.execute({ evalCase: args.evalCase });
  } catch (error) {
    // A target that cannot produce an output has not passed the attempt; record why, do not throw.
    return {
      index: args.index,
      output: { latencyMs: Date.now() - startedAt },
      scores: [{ scorer: "target", passed: false, value: 0, rationale: errorMessage(error) }],
      passed: false,
    };
  }

  const measured =
    output.latencyMs === undefined ? { ...output, latencyMs: Date.now() - startedAt } : output;
  const scores: Score[] = [];
  for (const scorer of args.scorers) {
    scores.push(await scorer({ evalCase: args.evalCase, output: measured }));
  }
  return {
    index: args.index,
    output: measured,
    scores,
    passed: scores.length > 0 && scores.every((score) => score.passed),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
