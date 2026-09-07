import type { PublishedToolContract } from "../contract";

export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 100 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Ceiling on a provider-supplied `Retry-After`.
 *
 * A provider that asks for an hour would otherwise pin a Run's attempt budget on its own clock,
 * and a hostile one could park a worker slot indefinitely. Five minutes is long enough for a real
 * rate-limit window and short enough that a wrong value is recoverable.
 */
export const MAX_PROVIDER_RETRY_DELAY_MS = 300_000;

/** Waits the longer of our backoff and the provider's stated window, within our own ceiling. */
export function nextRetryDelayMs(attempt: number, providerRetryAfterMs?: number): number {
  const backoff = retryDelayMs(attempt);
  if (providerRetryAfterMs === undefined || !Number.isFinite(providerRetryAfterMs)) return backoff;
  return Math.max(backoff, Math.min(providerRetryAfterMs, MAX_PROVIDER_RETRY_DELAY_MS));
}

export function maxDispatchAttempts(contract: PublishedToolContract): number {
  return Math.max(1, contract.retry?.maxAttempts ?? 1);
}

export function mayRetry(
  contract: PublishedToolContract,
  attempt: number,
  phase: "before_dispatch" | "after_dispatch"
): boolean {
  if (attempt >= maxDispatchAttempts(contract) || contract.retry?.safeToRetry !== true) {
    return false;
  }
  if (phase === "after_dispatch" && contract.mutating) return false;
  return true;
}
