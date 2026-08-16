import type { CompiledRetryPolicy } from "./compiler";

/**
 * Durable per-State-occurrence retry budget.
 *
 * A State that fails on a transient fault may be re-attempted, but the attempts it has already
 * spent must survive a park-and-resume and a crash-and-reclaim: a fresh execution that reloaded a
 * zero counter would hand every park a full `maxAttempts` budget, which is the L3-4 bug class one
 * layer up. The counter is therefore keyed by the State occurrence, exactly like the Run's budget
 * ledger and the Agent-loop checkpoint, and is written before each attempt so a crash mid-attempt
 * cannot refund it.
 */

/** The number of attempts a State occurrence has already consumed. */
export interface StateRetryAttempts {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly attempts: number;
}

export interface RecordStateRetryInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly attempts: number;
}

/**
 * Durable home for a State occurrence's spent attempt count. `record` is a monotonic upsert: a
 * counter only ever climbs, so a stale or racing writer can never lower a budget a later pass
 * already spent.
 */
export interface StateRetryStore {
  load(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<StateRetryAttempts | undefined>;
  record(input: RecordStateRetryInput): Promise<void>;
}

/** In-memory `StateRetryStore` for tests and the executor's non-durable default. */
export class InMemoryStateRetryStore implements StateRetryStore {
  private readonly counts = new Map<string, number>();

  private key(businessId: string, runId: string, stateKey: string): string {
    return `${businessId}\u0000${runId}\u0000${stateKey}`;
  }

  async load(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<StateRetryAttempts | undefined> {
    const attempts = this.counts.get(this.key(businessId, runId, stateKey));
    if (attempts === undefined) return undefined;
    return { businessId, runId, stateKey, attempts };
  }

  async record(input: RecordStateRetryInput): Promise<void> {
    const mapKey = this.key(input.businessId, input.runId, input.stateKey);
    const current = this.counts.get(mapKey) ?? 0;
    this.counts.set(mapKey, Math.max(current, input.attempts));
  }
}

/** A backoff is never allowed to hold a Run's lease longer than this, whatever the author asked. */
export const MAX_RETRY_BACKOFF_MS = 30_000;

/**
 * Delay before the next attempt of a State that has already made `attemptsMade` attempts
 * (`attemptsMade >= 1`). Exponential in the authored `multiplier`, clamped to
 * {@link MAX_RETRY_BACKOFF_MS} so a large authored backoff cannot strand a lease.
 */
export function retryBackoffMs(policy: CompiledRetryPolicy, attemptsMade: number): number {
  if (policy.backoffMs <= 0 || attemptsMade < 1) return 0;
  const raw = policy.backoffMs * policy.multiplier ** (attemptsMade - 1);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.round(raw), MAX_RETRY_BACKOFF_MS);
}
