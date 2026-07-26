export type AdmissionPriority = "normal" | "critical";

export interface AdmissionRequest {
  readonly id: string;
  readonly priority: AdmissionPriority;
  readonly persist: () => Promise<void>;
}

export interface AdmissionResult {
  readonly id: string;
  readonly outcome: "dispatch" | "delayed";
  readonly persisted: true;
}

/**
 * Persist-first admission. Saturated work remains durably delayed; critical
 * work alone may use reserved capacity.
 */
export class DurableAdmissionController {
  private inFlight = 0;

  constructor(
    private readonly limits: {
      readonly capacity: number;
      readonly reservedCapacity: number;
    }
  ) {
    if (
      !Number.isInteger(limits.capacity) ||
      limits.capacity < 1 ||
      !Number.isInteger(limits.reservedCapacity) ||
      limits.reservedCapacity < 0
    ) {
      throw new Error("admission capacity must be a positive integer");
    }
  }

  async admit(request: AdmissionRequest): Promise<AdmissionResult> {
    await request.persist();
    const limit =
      request.priority === "critical"
        ? this.limits.capacity + this.limits.reservedCapacity
        : this.limits.capacity;
    if (this.inFlight >= limit) {
      return { id: request.id, outcome: "delayed", persisted: true };
    }
    this.inFlight += 1;
    return { id: request.id, outcome: "dispatch", persisted: true };
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  currentInFlight(): number {
    return this.inFlight;
  }
}

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
