import type { ModelUsage } from "@tulipfarm/agent-runtime";
import type { EffortPreset, EffortRung } from "@tulipfarm/schema";
import type { PersistedRun } from "@tulipfarm/storage";

/**
 * Contracts a Turn executor requires of its host process.
 *
 * They live with the executor rather than with the Worker that implements them, so a second host —
 * the offline eval harness — can satisfy them without importing an app.
 */

/** Executor outcome; `waiting` parks, and `cancelled` is left to RunCancellationManager. */
export type RunOutcome = "succeeded" | "failed" | "waiting" | "needs_reconciliation" | "cancelled";

/** Executes one claimed Run to a terminal outcome. Registered per Run source at composition. */
export type RunExecutor = (run: PersistedRun, signal?: AbortSignal) => Promise<RunOutcome>;

/** One model call, as the spend ledger records it. */
export interface LlmCallRecord {
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly tier?: string;
  readonly usage?: ModelUsage;
  readonly durationMs?: number;
  readonly status: "ok" | "error";
  readonly runId?: string;
  readonly turnId?: string;
}

/** One finished turn, for the reliability and volume half of the dashboard. */
export interface TurnRecord {
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly durationMs?: number;
  readonly status: "ok" | "error";
  readonly runId?: string;
  readonly turnId?: string;
}

/**
 * Where the host reports what it spent.
 *
 * Both methods return void rather than a promise on purpose: recording spend must never be able
 * to fail, slow, or block the turn it is describing.
 */
export interface SpendSink {
  recordLlmCall(record: LlmCallRecord): void;
  recordTurn(record: TurnRecord): void;
}

export interface ModelCallReceipt {
  readonly modelId: string;
  /** What the participant asked for — including `auto`, which is a request, not an outcome. */
  readonly effortPreset?: EffortPreset;
  /** Actual rung, when knowable, so clients can escalate `auto` without guessing. */
  readonly effortApplied?: EffortRung;
  readonly modelCallLatencyMs: number;
}

/** Latest-call receipt is scoped to this Turn-attempt port, not a process registry. */
export interface ModelCallReceiptSource {
  latestModelCallReceipt(): ModelCallReceipt | undefined;
}
