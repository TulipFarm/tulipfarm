import { retryDelayMs } from "@tulipfarm/tool-broker";
import type { HostedToolCall, HostedToolResult } from "./authority";
import type { ChatEffectLedger } from "./effect-ledger";
import { executeToolWithTimeout } from "./timeout";
import type { RequestContext, ToolDef, ToolErrorCode } from "./types";
import { isIndeterminateFault, isInfrastructureFault } from "./types";

/** Default infra-fault retries without a ledger: one retry, then stop to avoid duplicate writes. */
const DEFAULT_TRANSIENT_ATTEMPTS = 2;

/** Matches the chat host's ceiling, so the same Tool is abandoned at the same point either way. */
const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;

/** The reserved effect this call must settle, if the Tool is one the ledger owns. */
export interface EffectReservation {
  readonly effectId: string;
  readonly attempt: number;
}

export interface ToolAttemptInput {
  readonly businessId: string;
  readonly tool: ToolDef;
  readonly call: HostedToolCall;
  readonly context: RequestContext;
  readonly timeoutMs?: number;
  readonly ledger?: ChatEffectLedger;
  readonly reservation?: EffectReservation;
}

/** Retry only infrastructure faults with budget; mutating Tools need explicit `safeToRetry`. */
function mayRetryFault(tool: ToolDef, code: ToolErrorCode, attempt: number): boolean {
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

  let result: Awaited<ReturnType<ToolDef["execute"]>>;
  for (let attempt = 1; ; attempt += 1) {
    try {
      result = await executeToolWithTimeout(
        tool,
        call.arguments,
        input.context,
        input.timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS
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
    if (!mayRetryFault(tool, result.error.code, attempt)) break;
    await wait(retryDelayMs(attempt));
  }
  if (isIndeterminateFault(result.error.code)) {
    await settle("ambiguous", "tool_timeout");
    return { status: "failed", reason: `tool "${call.name}" ${result.error.message}` };
  }
  // Structured errors have a known phase; there is nothing to reconcile.
  await settle("failed", result.error.code);
  // Schema-shaped rejections count against the model repair budget.
  if (result.error.code === "validation_error") {
    return { status: "invalid_arguments", reason: result.error.message };
  }
  if (result.error.code === "credential_required") {
    return {
      status: "denied",
      reason: result.error.message,
      ...(result.error.connectUrl === undefined ? {} : { connectUrl: result.error.connectUrl }),
    };
  }
  // Exhausted infra faults are machinery failures, not repairable argument failures.
  return isInfrastructureFault(result.error.code)
    ? { status: "failed", reason: `tool "${call.name}" is temporarily unavailable; try again` }
    : { status: "failed", reason: result.error.message };
}
