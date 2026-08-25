import { retryDelayMs } from "@tulipfarm/tool-broker";
import type { HostedToolCall, HostedToolResult } from "./authority";
import type { ChatEffectLedger } from "./effect-ledger";
import { executeToolWithTimeout } from "./timeout";
import type {
  ParkableToolCallResult,
  ParkableToolDef,
  RequestContext,
  ToolErrorCode,
} from "./types";
import { isIndeterminateFault, isInfrastructureFault, isParked } from "./types";

/** Default infra-fault retries without a ledger: one retry, then stop to avoid duplicate writes. */
const DEFAULT_TRANSIENT_ATTEMPTS = 2;

/**
 * Matches the chat host's ceiling, so the same Tool is abandoned at the same point either way.
 *
 * A Tool that genuinely needs longer declares `timeout.wallClockMs` rather than this being
 * raised for everything: the ceiling is what stops one stuck Tool holding a Run, and a Tool that
 * reads a slow website has no bearing on what a key-value read should be allowed to take.
 */
const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;

/**
 * How long this call may run, most specific declaration first.
 *
 * A Tool's own `wallClockMs` wins because only the Tool knows what it does; these are written in
 * code beside the handler, not supplied by a user, so there is nothing here to bound against.
 */
function executeTimeoutFor(tool: ParkableToolDef, hostTimeoutMs: number | undefined): number {
  return tool.definition?.timeout?.wallClockMs ?? hostTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;
}

/** The reserved effect this call must settle, if the Tool is one the ledger owns. */
export interface EffectReservation {
  readonly effectId: string;
  readonly attempt: number;
}

export interface ToolAttemptInput {
  readonly businessId: string;
  readonly tool: ParkableToolDef;
  readonly call: HostedToolCall;
  readonly context: RequestContext;
  readonly timeoutMs?: number;
  readonly ledger?: ChatEffectLedger;
  readonly reservation?: EffectReservation;
}

/** Retry only infrastructure faults with budget; mutating Tools need explicit `safeToRetry`. */
function mayRetryFault(tool: ParkableToolDef, code: ToolErrorCode, attempt: number): boolean {
  if (!isInfrastructureFault(code)) return false;
  // Provider Tools already spent their ledger retry budget; do not start a second effect.
  if (tool.definition?.provider !== undefined) return false;
  const policy = tool.definition?.retry;
  if (attempt >= Math.max(1, policy?.maxAttempts ?? DEFAULT_TRANSIENT_ATTEMPTS)) return false;
  // Without a phase, landed-then-failed is indistinguishable from never-landed.
  return !tool.mutating || policy?.safeToRetry === true;
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Runs one authorized Tool call to a terminal answer: bounded execution, the transient-fault retry
 * budget, and the effect settlement each outcome earns.
 *
 * Execution is never unbounded — a Tool that does not settle would otherwise hold the Run forever,
 * and one that does not honour its abort returns `indeterminate`, whose write may have landed after
 * the caller stopped waiting. That settles `ambiguous` for reconciliation, because `failed` reads
 * as never-landed and invites the retry that duplicates it.
 */
export async function runToolAttempts(input: ToolAttemptInput): Promise<HostedToolResult> {
  const { businessId, tool, call, ledger, reservation } = input;
  const settle = async (state: "confirmed" | "failed" | "ambiguous", errorCode?: string) => {
    if (!ledger || !reservation) return;
    await ledger.finishAttempt(businessId, reservation.effectId, reservation.attempt, {
      state,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  };

  let failure: Extract<ParkableToolCallResult, { success: false }>;
  for (let attempt = 1; ; attempt += 1) {
    let result: ParkableToolCallResult;
    try {
      result = await executeToolWithTimeout(
        tool,
        call.arguments,
        input.context,
        executeTimeoutFor(tool, input.timeoutMs)
      );
    } catch {
      // Throws are unknown phase: never retry, and settle ledgered writes as `ambiguous`.
      await settle("ambiguous", "tool_raised");
      return { status: "failed", reason: `tool "${call.name}" raised an internal error` };
    }
    if (result.success) {
      await settle("confirmed");
      return { status: "succeeded", output: result.data };
    }
    if (isParked(result)) {
      // The spawn committed and its wait is registered, so the effect is done — only the *answer*
      // is outstanding. Settling `confirmed` is what stops reconciliation later reading a Turn
      // that is merely waiting as a write that never landed. Never retried, because a park is by
      // definition a side effect that already happened.
      await settle("confirmed");
      return {
        status: "awaiting_child",
        childRunId: result.parked.childRunId,
        waitId: result.parked.waitId,
      };
    }
    if (!mayRetryFault(tool, result.error.code, attempt)) {
      failure = result;
      break;
    }
    await wait(retryDelayMs(attempt));
  }
  if (isIndeterminateFault(failure.error.code)) {
    await settle("ambiguous", "tool_timeout");
    return { status: "failed", reason: `tool "${call.name}" ${failure.error.message}` };
  }
  // Structured errors have a known phase; there is nothing to reconcile.
  await settle("failed", failure.error.code);
  // Schema-shaped rejections count against the model repair budget.
  if (failure.error.code === "validation_error") {
    return { status: "invalid_arguments", reason: failure.error.message };
  }
  if (failure.error.code === "credential_required") {
    return {
      status: "denied",
      reason: failure.error.message,
      ...(failure.error.connectUrl === undefined ? {} : { connectUrl: failure.error.connectUrl }),
    };
  }
  // Exhausted infra faults are machinery failures, not repairable argument failures.
  return isInfrastructureFault(failure.error.code)
    ? { status: "failed", reason: `tool "${call.name}" is temporarily unavailable; try again` }
    : { status: "failed", reason: failure.error.message };
}
