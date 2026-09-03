import { setTimeout as delay } from "node:timers/promises";
import {
  err,
  type ParkableToolCallResult,
  type ParkableToolDef,
  type RequestContext,
} from "./types";

/**
 * How long an aborted operation is given to acknowledge its cancellation before its outcome is
 * treated as indeterminate. A cooperating operation rejects on the signal in the same tick, so the
 * window only costs latency for work that ignored the abort — exactly the work we cannot trust.
 */
export const CANCELLATION_GRACE_MS = 2_000;

/** What the caller never saw: the operation settled after its deadline had already been answered. */
export type LateSettlement<T> =
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown };

/**
 * `cancelled` means the operation acknowledged its abort, so nothing it had not already committed
 * can land. `indeterminate` means it did not, so the side effect may or may not have happened and
 * only reconciliation can decide — never an automatic retry.
 */
export type CancellationOutcome<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "cancelled" }
  | { readonly kind: "indeterminate" };

export interface CancellationOptions<T> {
  readonly graceMs?: number;
  /** The host's own cancellation, e.g. Run cancellation or shutdown; aborts before the deadline. */
  readonly outerSignal?: AbortSignal;
  readonly onLateSettlement?: (settlement: LateSettlement<T>) => void;
}

const EXPIRED = Symbol("expired");

/**
 * Runs an operation under a deadline, aborts it when the deadline expires, and then reports
 * whether the abort was actually honoured.
 *
 * A plain `Promise.race` against a timer cannot tell a cancelled operation from one that is still
 * mutating state, and it drops whatever the loser eventually produced. Both matter: the first
 * decides whether a retry is safe, the second is the only evidence that a write landed after the
 * caller was told it had failed.
 */
export async function runWithCancellation<T>(
  execute: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: CancellationOptions<T> = {}
): Promise<CancellationOutcome<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const { outerSignal, onLateSettlement } = options;
  if (outerSignal?.aborted === true) abort();
  else outerSignal?.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(abort, timeoutMs) : undefined;
  const release = () => {
    if (timer !== undefined) clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abort);
  };

  // Settlement is observed rather than raced away, so a result arriving after the deadline is
  // still reportable instead of vanishing into an unobserved promise.
  const observed: Promise<LateSettlement<T>> = (async () => {
    try {
      return { kind: "resolved", value: await execute(controller.signal) };
    } catch (error) {
      return { kind: "rejected", error };
    }
  })();
  const aborted = new Promise<typeof EXPIRED>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(EXPIRED), { once: true });
  });

  const first = await Promise.race([observed, aborted]);
  if (first !== EXPIRED) {
    release();
    if (first.kind === "rejected") throw first.error;
    return { kind: "settled", value: first.value };
  }

  const grace = delay(options.graceMs ?? CANCELLATION_GRACE_MS, EXPIRED);
  const acknowledged = await Promise.race([observed, grace]);
  release();
  if (acknowledged === EXPIRED) {
    if (onLateSettlement !== undefined) void observed.then(onLateSettlement);
    return { kind: "indeterminate" };
  }
  if (acknowledged.kind === "rejected") return { kind: "cancelled" };
  onLateSettlement?.(acknowledged);
  return { kind: "indeterminate" };
}

export interface ToolTimeoutOptions {
  readonly graceMs?: number;
  readonly onLateSettlement?: (settlement: LateSettlement<ParkableToolCallResult>) => void;
}

/** Written for the model, so it says what to do rather than inviting the retry that duplicates. */
export const INDETERMINATE_TIMEOUT_MESSAGE =
  "tool execution timed out and could not be cancelled; the change may already have been " +
  "applied — verify the current state before attempting it again";

/**
 * Executes a Tool under a deadline with a per-invocation cancellation signal, and reports a
 * mutating Tool that ignored its abort as `indeterminate` rather than a failure a caller may retry.
 */
export async function executeToolWithTimeout(
  tool: ParkableToolDef,
  args: unknown,
  context: RequestContext,
  timeoutMs: number,
  options: ToolTimeoutOptions = {}
): Promise<ParkableToolCallResult> {
  const outcome = await runWithCancellation(
    (abortSignal) => tool.execute(args, { ...context, abortSignal }),
    timeoutMs,
    {
      ...(context.abortSignal === undefined ? {} : { outerSignal: context.abortSignal }),
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      ...(options.onLateSettlement === undefined
        ? {}
        : { onLateSettlement: options.onLateSettlement }),
    }
  );
  if (outcome.kind === "settled") return outcome.value;
  // A read that timed out committed nothing, so there is nothing to reconcile either way.
  if (outcome.kind === "cancelled" || !tool.mutating) {
    return err("internal_error", "tool execution timed out");
  }
  return err("indeterminate", INDETERMINATE_TIMEOUT_MESSAGE);
}
