import {
  ModelInvocationError,
  type ModelInvocationFailureReason,
  type ModelPort,
  type ModelUsage,
} from "@tulipfarm/agent-runtime";

/**
 * Vendor failures worth a second attempt.
 *
 * Everything else is a standing condition — a wrong key, a withdrawn model, an inactive account —
 * and retrying it only spends the Sweep's wall clock to reach the same answer.
 */
export const TRANSIENT_REASONS: ReadonlySet<ModelInvocationFailureReason> = new Set([
  "model_rate_limited",
  "model_provider_unavailable",
]);

export interface RetryPolicy {
  /** Total attempts, including the first. `1` disables retrying. */
  readonly attempts: number;
  readonly backoffMs: number;
  sleep?(ms: number): Promise<void>;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, backoffMs: 2000 };

export interface RetryObserver {
  /**
   * What a failed attempt consumed.
   *
   * A rate-limited call that already submitted a prompt was billed for it. Counting only the
   * attempt that succeeded is how a retry-heavy Sweep comes in under a spend ceiling it actually
   * blew through.
   */
  attemptUsage?(usage: ModelUsage | undefined): void;
  retried?(reason: ModelInvocationFailureReason): void;
}

/**
 * Retries transient vendor failures, closest to the vendor so nothing above sees them.
 *
 * The retry lives here rather than in the SDK's own policy because a Sweep has to report a retry
 * as a retry: a run whose vendor was throttled throughout is not the same evidence as a clean
 * one, even when both end green.
 */
export function withRetry(
  port: ModelPort,
  policy: RetryPolicy = DEFAULT_RETRY,
  observer: RetryObserver = {}
): ModelPort {
  const sleep = policy.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  return {
    invoke: async (request) => {
      // Hoisted so the loop bound and the give-up test cannot disagree: with `attempts: 0` they
      // did, and a Trial reported a retry it never performed after sleeping a full backoff.
      const attempts = Math.max(1, policy.attempts);
      let last: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await port.invoke(request);
        } catch (error) {
          last = error;
          const reason = error instanceof ModelInvocationError ? error.reason : undefined;
          if (error instanceof ModelInvocationError) observer.attemptUsage?.(error.usage);
          if (reason === undefined || !TRANSIENT_REASONS.has(reason)) throw error;
          if (attempt === attempts) throw error;
          observer.retried?.(reason);
          // Linear backoff on the attempt number. A rate limit clears on the vendor's clock, not
          // ours, so the point is to stop hammering, not to model their window.
          await sleep(policy.backoffMs * attempt);
        }
      }
      throw last;
    },
  };
}
