import type { PublishedToolContract } from "../contract";

export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 100 * 2 ** Math.max(0, attempt - 1));
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
