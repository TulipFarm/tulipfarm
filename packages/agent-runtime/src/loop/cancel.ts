/** How a Turn stops a model call that is already in flight. */

import type { ModelUsage } from "../ports/model";

/**
 * How often the loop asks whether the Run was cancelled while a model call is running.
 *
 * The loop's own check sits at the top of an iteration, which is too late once the call has
 * started: a Turn cancelled at the first token keeps streaming, and keeps spending, until the
 * provider is finished. Polling on a timer rather than per chunk keeps the cost off the hot path,
 * because a chunk can arrive many times a second and every check is a database read.
 */
export const CANCEL_POLL_MS = 500;

/** Abort reason for a call the loop stopped, so a provider timeout stays tellable from a stop. */
export const CANCELLED_REASON = "agent_loop_cancelled";

/** Raised when a model call was stopped because the Run was cancelled, not because it failed. */
export class TurnCancelled extends Error {
  /**
   * @param usage What the provider had already consumed when the call stopped, when it said so.
   *   Carried because a stop does not refund the tokens spent before it: dropping them here would
   *   let a Run that is started and stopped repeatedly spend against a budget it never charges.
   */
  constructor(readonly usage?: ModelUsage) {
    super("the Run was cancelled while the model call was in flight");
    this.name = "TurnCancelled";
  }
}

export interface CancelWatch {
  /** Handed to the provider, so the call itself stops rather than running on unread. */
  readonly signal: AbortSignal;
  /** Whether the Run has been seen to be cancelling. */
  cancelled(): boolean;
  stop(): void;
}

/**
 * Watches for cancellation for the length of one model call.
 *
 * Polls rather than subscribes because cancellation is a row in the database, written by whichever
 * process served the stop — there is no in-process event to listen for. A read that fails is not
 * an answer either way, so it is ignored and retried on the next tick: ending a Turn nobody stopped
 * because the database blinked would be the worse failure.
 */
export function watchForCancel(
  isCancelled: () => Promise<boolean>,
  intervalMs: number = CANCEL_POLL_MS
): CancelWatch {
  const controller = new AbortController();
  let polling = false;

  const timer = setInterval(() => {
    // One read at a time: a slow status read would otherwise stack a queue of them behind it.
    if (polling) return;
    polling = true;
    void isCancelled()
      .then((stopped) => {
        if (stopped) controller.abort(CANCELLED_REASON);
      })
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    cancelled: () => controller.signal.aborted,
    stop: () => clearInterval(timer),
  };
}
