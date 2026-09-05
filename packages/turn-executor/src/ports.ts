import type { ModelUsage } from "@tulipfarm/agent-runtime";
import type { EffortPreset, EffortRung } from "@tulipfarm/schema";
import type { PersistedRun } from "@tulipfarm/storage";

/**
 * Contracts a Turn executor requires of its host process.
 *
 * They live with the executor rather than with the Worker that implements them, so a second host —
 * the offline eval harness — can satisfy them without importing an app.
 */

/** The terminal or parking status a Run executor settles into. */
export type RunOutcomeStatus =
  | "succeeded"
  | "failed"
  | "waiting"
  | "needs_reconciliation"
  | "cancelled";

/**
 * Executor outcome; `waiting` parks, and `cancelled` is left to RunCancellationManager.
 *
 * An object rather than a bare status so a semantic failure — one the executor detects and
 * reports itself, as opposed to a thrown error the dispatcher catches — has a channel to say
 * *why*. Widened deliberately over a discriminated union: every existing call site returned a
 * bare string, so a plain object with an optional field is the smallest change that still fails
 * the build at every site that has not been converted to the new shape.
 *
 * `errorEvidenceRef` is an operator-facing breadcrumb, not a payload: keep it a terse, bounded,
 * enumerable code in the existing `namespace:reason` style (`routine:agent_tool_call_limit`,
 * `dispatch:handler_error`). It is read by operators and travels into audit surfaces, so it must
 * never carry model output, tool arguments, user content, or a raw exception message.
 */
export interface RunOutcome {
  readonly status: RunOutcomeStatus;
  readonly errorEvidenceRef?: string;
}

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
  /** Whom the call acted as, kind included, so spend can be grouped by member. */
  readonly principal?: { readonly kind: string; readonly id: string };
}

/** One finished turn, for the reliability and volume half of the dashboard. */
export interface TurnRecord {
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly durationMs?: number;
  readonly status: "ok" | "error";
  readonly runId?: string;
  readonly turnId?: string;
  /** Whom the turn acted as, kind included, so spend can be grouped by member. */
  readonly principal?: { readonly kind: string; readonly id: string };
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
