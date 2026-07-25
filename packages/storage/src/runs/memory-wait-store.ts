import type {
  CreateWaitInput,
  DueWaitDecision,
  PersistedWait,
  PersistedWaitSignal,
  ResolvedDueWait,
  WaitDeliveryResult,
  WaitSignalInput,
  WaitSignalPolicy,
} from "./wait-store";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface StoredWait {
  wait: PersistedWait;
  tokenHash: string;
}

/**
 * In-memory `WaitStore` with the same one-use-token, deduplication, and resolution semantics, for
 * tests and local wiring. Single-threaded JavaScript gives the atomicity the row lock gives in
 * PostgreSQL: each delivery runs to completion before the next observes state.
 */
export class MemoryWaitStore {
  private readonly waits = new Map<string, StoredWait>();
  private readonly signals = new Map<string, PersistedWaitSignal>();

  private key(businessId: string, waitId: string): string {
    return JSON.stringify([businessId, waitId]);
  }

  private byToken(businessId: string, tokenHash: string): StoredWait | undefined {
    for (const stored of this.waits.values()) {
      if (stored.wait.businessId === businessId && stored.tokenHash === tokenHash) return stored;
    }
    return undefined;
  }

  private countSignals(businessId: string, waitId: string): number {
    let count = 0;
    for (const signal of this.signals.values()) {
      if (signal.businessId === businessId && signal.waitId === waitId) count += 1;
    }
    return count;
  }

  async create(input: CreateWaitInput): Promise<PersistedWait> {
    if (this.waits.has(this.key(input.businessId, input.id))) {
      throw new Error("run_wait_conflict");
    }
    if (this.byToken(input.businessId, input.tokenHash)) {
      throw new Error("run_wait_token_conflict");
    }
    const wait: PersistedWait = {
      id: input.id,
      businessId: input.businessId,
      runId: input.runId,
      stateKey: input.stateKey,
      kind: input.kind,
      aggregation: input.aggregation,
      status: "pending",
      schemaRef: input.schemaRef,
      allowedPrincipals: [...input.allowedPrincipals],
      expectedSignals: input.expectedSignals,
      quorum: input.quorum,
      deadlineAt: input.deadlineAt,
      createdAt: input.createdAt,
      resolvedAt: null,
      version: 0,
    };
    this.waits.set(this.key(input.businessId, input.id), { wait, tokenHash: input.tokenHash });
    return clone(wait);
  }

  async find(businessId: string, waitId: string): Promise<PersistedWait | null> {
    const stored = this.waits.get(this.key(businessId, waitId));
    return stored ? clone(stored.wait) : null;
  }

  async listSignals(businessId: string, waitId: string): Promise<readonly PersistedWaitSignal[]> {
    return [...this.signals.values()]
      .filter((signal) => signal.businessId === businessId && signal.waitId === waitId)
      .sort(
        (left, right) =>
          left.receivedAt.localeCompare(right.receivedAt) ||
          left.correlationKey.localeCompare(right.correlationKey)
      )
      .map((signal) => clone(signal));
  }

  async deliverSignal(
    input: WaitSignalInput,
    policy: WaitSignalPolicy
  ): Promise<WaitDeliveryResult> {
    const stored = this.byToken(input.businessId, input.tokenHash);
    if (!stored) return { outcome: "unknown_token", reason: null, wait: null, signalCount: 0 };

    const wait = clone(stored.wait);
    const signalKey = JSON.stringify([input.businessId, wait.id, input.correlationKey]);
    const isDuplicate = this.signals.has(signalKey);

    const denial = policy.authorize(wait, isDuplicate);
    if (denial !== null) return { outcome: "denied", reason: denial, wait, signalCount: 0 };

    if (isDuplicate) {
      return {
        outcome: "duplicate",
        reason: null,
        wait,
        signalCount: this.countSignals(input.businessId, wait.id),
      };
    }
    this.signals.set(signalKey, {
      id: input.id,
      businessId: input.businessId,
      waitId: wait.id,
      correlationKey: input.correlationKey,
      signalDigest: input.signalDigest,
      principal: input.principal,
      receivedAt: input.receivedAt,
    });
    const signalCount = this.countSignals(input.businessId, wait.id);

    if (!policy.isSatisfied(wait, signalCount)) {
      return { outcome: "recorded", reason: null, wait, signalCount };
    }
    stored.wait = {
      ...stored.wait,
      status: "satisfied",
      resolvedAt: input.receivedAt,
      version: stored.wait.version + 1,
    };
    return { outcome: "resolved", reason: null, wait: clone(stored.wait), signalCount };
  }

  async resolveDue(
    businessId: string,
    now: string,
    limit: number,
    decide: DueWaitDecision
  ): Promise<readonly ResolvedDueWait[]> {
    const due = [...this.waits.values()]
      .filter(
        (stored) =>
          stored.wait.businessId === businessId &&
          stored.wait.status === "pending" &&
          stored.wait.deadlineAt <= now
      )
      .sort((left, right) => left.wait.deadlineAt.localeCompare(right.wait.deadlineAt))
      .slice(0, Math.max(0, limit));

    return due.map((stored) => {
      const signalCount = this.countSignals(businessId, stored.wait.id);
      stored.wait = {
        ...stored.wait,
        status: decide(clone(stored.wait), signalCount),
        resolvedAt: now,
        version: stored.wait.version + 1,
      };
      return { wait: clone(stored.wait), signalCount };
    });
  }
}
