import type { EvalSeverity } from "@tulipfarm/agent-runtime";

/**
 * Harness types for TulipFarm AI evals.
 *
 * These build on the gate primitives in `@tulipfarm/agent-runtime` (`EvalSeverity`, `EvalReport`,
 * `evaluateActivation`). The harness measures REAL targets (a model or the agent loop) against
 * versioned cases, scores each run with code and/or judge scorers, and repeats each case to smooth
 * over model nondeterminism. The rich `EvalRunReport` reduces to the agent-runtime `EvalReport`
 * (see `report.ts`) so the existing publication activation gate keeps working unchanged.
 */

export type { EvalSeverity };

/** A tool call observed on a target's output — the seam the `toolCalled` scorer inspects. */
export interface ToolCallObservation {
  readonly name: string;
  readonly arguments: unknown;
}

export interface TargetUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

/** Normalized result of running one case against a target, whatever the target's shape. */
export interface TargetOutput {
  /** Assistant text, when the target produced any. */
  readonly text?: string;
  /** Tool calls the target decided to make (single-step model or full loop). */
  readonly toolCalls?: readonly ToolCallObservation[];
  /** Structured/JSON output, when the target returned one. */
  readonly structured?: unknown;
  readonly usage?: TargetUsage;
  readonly latencyMs?: number;
}

export type EvalTargetKind = "model" | "agent-loop";

/**
 * Free-form input to a target. `prompt` or `messages` drive the model; `context` is the reference
 * text a faithfulness rubric grades against. Unknown keys are preserved for custom targets.
 */
export interface EvalCaseInput {
  readonly prompt?: string;
  readonly messages?: readonly { readonly role: string; readonly content: string }[];
  readonly context?: string;
  readonly [key: string]: unknown;
}

/**
 * A single eval case. Versioned: changing expectations produces a new `version`, never a silent
 * edit (mirrors the agent-runtime `EvalCase` contract). `runs`/`minPassRate` override the suite
 * defaults per case when a specific case needs a stricter or looser threshold.
 */
export interface EvalCase {
  readonly caseId: string;
  readonly version: string;
  readonly severity: EvalSeverity;
  readonly input: EvalCaseInput;
  /** Reference output for deterministic scorers (exactMatch, contains, recall@k …). */
  readonly expected?: unknown;
  /** Rubric text for the LLM-judge scorer, when this case is judged. */
  readonly rubric?: string;
  /** Documentation of which target this case is authored for; the runner picks the target. */
  readonly target?: EvalTargetKind;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly runs?: number;
  readonly minPassRate?: number;
}

export interface Score {
  readonly scorer: string;
  readonly passed: boolean;
  /** Normalized 0..1 signal (1 = fully passing); code scorers usually emit 0 or 1. */
  readonly value: number;
  readonly rationale?: string;
}

export interface ScoreArgs {
  readonly evalCase: EvalCase;
  readonly output: TargetOutput;
}

/** A scorer turns a target output into one pass/fail signal. Pure or judge-backed. */
export type Scorer = (args: ScoreArgs) => Score | Promise<Score>;

/** One execution of a case: the output produced and every scorer's verdict on it. */
export interface RunAttempt {
  readonly index: number;
  readonly output: TargetOutput;
  readonly scores: readonly Score[];
  readonly passed: boolean;
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly version: string;
  readonly severity: EvalSeverity;
  readonly runs: number;
  readonly passes: number;
  readonly passRate: number;
  readonly minPassRate: number;
  readonly passed: boolean;
  readonly attempts: readonly RunAttempt[];
}

export interface EvalRunReport {
  readonly suite: string;
  readonly suiteVersion: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly results: readonly EvalCaseResult[];
  readonly passed: number;
  readonly failed: number;
  readonly digest: string;
}

/** Where a completed run report is delivered (file, database, in-memory, …). */
export interface EvalReportSink {
  write(report: EvalRunReport): Promise<void>;
}

/** A source of cases for a named, versioned suite (file today, database later). */
export interface EvalDataset {
  readonly suite: string;
  readonly suiteVersion: string;
  readonly cases: readonly EvalCase[];
}

export interface DatasetSource {
  load(suite: string): Promise<EvalDataset>;
}
