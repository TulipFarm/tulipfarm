export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly recoveryAfterMs: number;
  readonly now?: () => number;
}

export type CircuitBreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitBreakerState = "closed";
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    if (
      !Number.isInteger(options.failureThreshold) ||
      options.failureThreshold < 1 ||
      !Number.isFinite(options.recoveryAfterMs) ||
      options.recoveryAfterMs < 0
    ) {
      throw new Error("invalid circuit breaker limits");
    }
    this.now = options.now ?? Date.now;
  }

  tryAcquire(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open" && this.now() - this.openedAt >= this.options.recoveryAfterMs) {
      this.state = "half_open";
      this.probeInFlight = false;
    }
    if (this.state !== "half_open" || this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordFailure(): void {
    if (this.state === "half_open") {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) this.open();
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.probeInFlight = false;
  }

  currentState(): CircuitBreakerState {
    return this.state;
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.probeInFlight = false;
  }
}
