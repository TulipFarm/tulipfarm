import {
  type FallbackCallGate,
  type FallbackCallLease,
  ProviderUnavailableError,
} from "@tulipfarm/llm";
import { CircuitBreaker } from "@tulipfarm/observability";

/** Parallel in-flight calls allowed against one provider before further turns queue. */
const DEFAULT_MAX_CONCURRENCY = 8;

/** One failed link is enough to move new calls to its configured fallback. */
const DEFAULT_FAILURE_THRESHOLD = 1;

/** How long a shed provider is left alone before one probe call is allowed through. */
const DEFAULT_RECOVERY_MS = 30_000;

/** Longest a turn waits for a slot before it is better to fail than to keep holding a lease. */
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

export type ModelCallLease = FallbackCallLease;
export type ModelCallGate = FallbackCallGate;

export interface ProviderGateOptions {
  readonly maxConcurrency?: number;
  readonly failureThreshold?: number;
  readonly recoveryAfterMs?: number;
  readonly queueTimeoutMs?: number;
  now?(): number;
}

interface ProviderState {
  readonly breaker: CircuitBreaker;
  inFlight: number;
  readonly waiting: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    onAbort?: () => void;
  }[];
}

function abortError(): DOMException {
  return new DOMException("The model call was aborted", "AbortError");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Bounds what this process may do to one model provider.
 *
 * Nothing bounded model calls before: no concurrency cap, no breaker, no admission control, so N
 * parallel turns stampeded a single provider and a provider having a bad minute was met with the
 * maximum possible load. `CircuitBreaker` already existed for exactly this and had no callers.
 *
 * Scope is deliberately per-process, not per-deployment: a worker can only limit what it is
 * itself sending, and a cross-process limiter would need coordination this does not have.
 */
export class ProviderGate implements ModelCallGate {
  private readonly providers = new Map<string, ProviderState>();
  private readonly maxConcurrency: number;
  private readonly queueTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly recoveryAfterMs: number;
  private readonly now: () => number;

  constructor(options: ProviderGateOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.recoveryAfterMs = options.recoveryAfterMs ?? DEFAULT_RECOVERY_MS;
    this.now = options.now ?? Date.now;
  }

  async acquire(provider: string, signal?: AbortSignal): Promise<ModelCallLease> {
    const state = this.stateFor(provider);

    if (isAborted(signal)) throw abortError();

    if (state.inFlight >= this.maxConcurrency) await this.waitForSlot(provider, state, signal);
    else state.inFlight += 1;

    if (isAborted(signal)) {
      state.inFlight = Math.max(0, state.inFlight - 1);
      this.wake(state);
      throw abortError();
    }

    // Checked after the slot is held, never before. `tryAcquire` consumes the breaker's single
    // half-open probe, and a call that then failed to get capacity would leave that probe
    // outstanding forever — wedging the provider shut with no call in flight to reopen it.
    if (!state.breaker.tryAcquire()) {
      state.inFlight = Math.max(0, state.inFlight - 1);
      this.wake(state);
      throw new ProviderUnavailableError(provider, "circuit open after repeated failures");
    }

    const halfOpenProbe = state.breaker.currentState() === "half_open";
    let outcome = false;
    let settled = false;
    return {
      succeeded: () => {
        if (outcome) return;
        outcome = true;
        state.breaker.recordSuccess();
      },
      failed: () => {
        if (outcome) return;
        outcome = true;
        state.breaker.recordFailure();
      },
      cancelled: () => {
        if (outcome) return;
        outcome = true;
        if (halfOpenProbe) state.breaker.abandonProbe();
      },
      release: () => {
        if (settled) return;
        settled = true;
        // A forgotten outcome must not strand the breaker's single half-open probe or erase its
        // failure history. Only a completed provider response closes the circuit.
        if (!outcome && halfOpenProbe) state.breaker.abandonProbe();
        state.inFlight = Math.max(0, state.inFlight - 1);
        this.wake(state);
      },
    };
  }

  /** In-flight calls per provider, for tests and operator diagnostics. */
  inFlight(provider: string): number {
    return this.providers.get(provider)?.inFlight ?? 0;
  }

  private stateFor(provider: string): ProviderState {
    const existing = this.providers.get(provider);
    if (existing !== undefined) return existing;
    const state: ProviderState = {
      breaker: new CircuitBreaker({
        failureThreshold: this.failureThreshold,
        recoveryAfterMs: this.recoveryAfterMs,
        now: this.now,
      }),
      inFlight: 0,
      waiting: [],
    };
    this.providers.set(provider, state);
    return state;
  }

  private waitForSlot(
    provider: string,
    state: ProviderState,
    signal: AbortSignal | undefined
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const remove = (waiter: ProviderState["waiting"][number]) => {
        const index = state.waiting.indexOf(waiter);
        if (index >= 0) state.waiting.splice(index, 1);
        clearTimeout(waiter.timer);
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
      };
      const timer = setTimeout(() => {
        remove(waiter);
        reject(new ProviderUnavailableError(provider, "no capacity within the queue budget"));
      }, this.queueTimeoutMs);
      timer.unref?.();
      const waiter: ProviderState["waiting"][number] = { resolve, reject, timer };
      if (signal !== undefined) {
        const onAbort = () => {
          remove(waiter);
          reject(abortError());
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      state.waiting.push(waiter);
      if (isAborted(signal)) waiter.onAbort?.();
    });
  }

  /**
   * Hands the freed slot directly to the longest-waiting caller.
   *
   * The count is re-incremented here rather than by the woken caller: resuming an awaited promise
   * is a microtask, and a caller arriving in that window would otherwise see free capacity and
   * take the slot out from under the waiter, putting the provider over its cap.
   */
  private wake(state: ProviderState): void {
    const next = state.waiting.shift();
    if (next === undefined) return;
    clearTimeout(next.timer);
    if (next.signal !== undefined && next.onAbort !== undefined) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    state.inFlight += 1;
    next.resolve();
  }
}
