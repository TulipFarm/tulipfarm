import type { RoutineDefinition } from "@tulipfarm/validation";

/** Trigger that started a run. `payload` is the trigger-specific input. */
export interface RunTrigger {
  type: "event" | "manual" | "cron" | "webhook" | "agent";
  payload?: unknown;
}

/**
 * The interpreter's view of a run: everything needed to execute the *next* state.
 * Persistence (rows, journal seq, wake bookkeeping) is the caller's concern — the
 * engine only reads/produces these fields.
 */
export interface RunSnapshot {
  runId: string;
  slug: string;
  /** definitionSnapshot — pinned at run creation (ROUT-V1-007). */
  definition: RoutineDefinition;
  /** Name of the state to execute next. */
  currentState: string;
  /** Data-flow context, threaded state to state. */
  context: Record<string, unknown>;
  trigger: RunTrigger;
  /** Per-state retry attempt counts, keyed by state name. */
  attemptCounts: Record<string, number>;
  /**
   * Approval decision for `currentState`, when resuming a human_approval gate.
   * Absent ⇒ the gate has not been requested/decided yet.
   */
  approvalOutcome?: "approved" | "denied";
}

export interface RunError {
  /** Stable error name used for onErrors matching (e.g. "action_failed", "timeout"). */
  name: string;
  message: string;
  /** State the error surfaced in. */
  state: string;
}

/** Approval request produced by a human_approval state (ROUT-V1-003/006). */
export interface ApprovalRequest {
  stateName: string;
  /** Declared channels, unfiltered — channel fallback (email/sms → ui) is the caller's job. */
  channels: string[];
  /** Context snapshot for the approver UI/message. */
  summary: Record<string, unknown>;
}

/** Outcome of executing one state. The driver persists, then acts on it. */
export type StepOutcome =
  | { type: "continue"; nextState: string; context: Record<string, unknown> }
  | { type: "complete"; output: Record<string, unknown> }
  | { type: "fail"; error: RunError }
  | {
      type: "sleep";
      until: Date;
      /** State to resume at after waking; null ⇒ the run completes on wake. */
      nextState: string | null;
      context: Record<string, unknown>;
    }
  | { type: "wait_approval"; request: ApprovalRequest }
  | {
      type: "retry";
      /** Delay before re-executing the same state. */
      delayMs: number;
      attempt: number;
      error: RunError;
    };

/**
 * Engine-emitted run events. The driver journals these (durable history) and fans them
 * out over SSE. Terminal event types are exactly "finish" / "error" so the existing
 * StreamHub close semantics apply unchanged.
 */
export interface RunEvent {
  type:
    | "run.started"
    | "state.entered"
    | "action.completed"
    | "state.completed"
    | "state.retrying"
    | "run.sleeping"
    | "run.waiting_approval"
    | "finish"
    | "error";
  data: Record<string, unknown>;
}

/** Whole-routine lifecycle hook names (hooks.ts contract). */
export const LIFECYCLE_HOOKS = { beforeRun: "beforeHook", afterRun: "afterHook" } as const;

/** Per-state lifecycle hook names: before<StateName> / after<StateName>. */
export function stateHookNames(stateName: string): { before: string; after: string } {
  const cap = stateName.charAt(0).toUpperCase() + stateName.slice(1);
  return { before: `before${cap}`, after: `after${cap}` };
}
