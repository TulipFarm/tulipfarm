import type { PersistedRun, PersistedRunStatus } from "@tulipfarm/storage";
import { assertRunTransition, type RunStatus } from "./model";

/** Statuses that require an owned, timed worker lease (`runs` table CHECK enforces this). */
export type LeasedRunStatus = "claimed" | "running";

/** Narrow surface `RunLeaseManager` needs; `@tulipfarm/storage`'s `RunStore` satisfies it. */
export interface RunLeaseStore {
  transitionRun(
    businessId: string,
    runId: string,
    transition: {
      expectedVersion: number;
      expectedStatus: PersistedRunStatus;
      status: PersistedRunStatus;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
    }
  ): Promise<boolean>;
  heartbeat(
    businessId: string,
    runId: string,
    owner: string,
    heartbeat: { expectedVersion: number; leaseExpiresAt: string }
  ): Promise<boolean>;
  reclaimExpiredRuns(
    businessId: string,
    now: string,
    limit: number
  ): Promise<readonly PersistedRun[]>;
  claimNextQueued(
    businessId: string,
    owner: string,
    input: { now: string; leaseDurationMs: number; limit: number }
  ): Promise<readonly PersistedRun[]>;
  find(businessId: string, runId: string): Promise<PersistedRun | null>;
}

export interface ClaimInput {
  readonly businessId: string;
  readonly runId: string;
  readonly owner: string;
  readonly now: Date;
  readonly leaseDurationMs: number;
  readonly expectedVersion: number;
  readonly expectedStatus: RunStatus;
  readonly status: LeasedRunStatus;
}

export interface ClaimResult {
  readonly claimed: boolean;
  readonly run: PersistedRun | null;
}

export interface HeartbeatInput {
  readonly businessId: string;
  readonly runId: string;
  readonly owner: string;
  readonly now: Date;
  readonly leaseDurationMs: number;
  readonly expectedVersion: number;
}

export interface ReleaseInput {
  readonly businessId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly expectedStatus: RunStatus;
  readonly status: Exclude<RunStatus, LeasedRunStatus>;
}

export interface ReclaimInput {
  readonly businessId: string;
  readonly now: Date;
  readonly limit: number;
}

export interface ClaimBatchInput {
  readonly businessId: string;
  readonly owner: string;
  readonly now: Date;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

/**
 * Worker-lease behavior for durable Runs: claim (fresh or reclaimed), heartbeat, release, and
 * bulk expiry reclaim. Every transition is validated against the canonical state machine before
 * the CAS-guarded, persist-first write, so an illegal transition never reaches storage.
 */
export class RunLeaseManager {
  constructor(private readonly store: RunLeaseStore) {}

  /** Enters or stays in a leased status (`queued`->`claimed` or `claimed`->`running`). */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    assertRunTransition(input.expectedStatus, input.status);
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs).toISOString();
    const claimed = await this.store.transitionRun(input.businessId, input.runId, {
      expectedVersion: input.expectedVersion,
      expectedStatus: input.expectedStatus,
      status: input.status,
      leaseOwner: input.owner,
      leaseExpiresAt,
    });
    if (!claimed) return { claimed: false, run: null };
    return { claimed: true, run: await this.store.find(input.businessId, input.runId) };
  }

  /** Extends an owned lease without changing status; fails if another worker now owns it. */
  async heartbeat(input: HeartbeatInput): Promise<boolean> {
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs).toISOString();
    return this.store.heartbeat(input.businessId, input.runId, input.owner, {
      expectedVersion: input.expectedVersion,
      leaseExpiresAt,
    });
  }

  /** Leaves a leased status for a non-leased one, clearing the lease. */
  async release(input: ReleaseInput): Promise<boolean> {
    assertRunTransition(input.expectedStatus, input.status);
    return this.store.transitionRun(input.businessId, input.runId, {
      expectedVersion: input.expectedVersion,
      expectedStatus: input.expectedStatus,
      status: input.status,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /** Requeues Runs whose worker lease expired so a new worker can claim them. */
  async reclaimExpired(input: ReclaimInput): Promise<readonly PersistedRun[]> {
    return this.store.reclaimExpiredRuns(input.businessId, input.now.toISOString(), input.limit);
  }

  /** Claims a batch of due, queued Runs with an owned lease for a worker to dispatch. */
  async claimBatch(input: ClaimBatchInput): Promise<readonly PersistedRun[]> {
    return this.store.claimNextQueued(input.businessId, input.owner, {
      now: input.now.toISOString(),
      leaseDurationMs: input.leaseDurationMs,
      limit: input.limit,
    });
  }
}
