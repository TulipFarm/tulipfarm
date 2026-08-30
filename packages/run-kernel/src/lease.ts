import type { PersistedRun, PersistedRunStatus } from "@tulipfarm/storage";
import { assertRunTransition, type RunStatus } from "./model";

export type LeasedRunStatus = "claimed" | "running";

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
      errorEvidenceRef?: string;
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
  /** Requeues Runs parked by a crashed dispatch handler; bounded to once per Run by the store. */
  requeueParkedRuns(businessId: string, limit: number): Promise<readonly PersistedRun[]>;
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
  /** Terse reason code for a non-terminal park (e.g. `needs_reconciliation`); never secrets or model content. */
  readonly errorEvidenceRef?: string;
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

/** Lease writes validate canonical transitions before the CAS-guarded persist-first update. */
export class RunLeaseManager {
  constructor(private readonly store: RunLeaseStore) {}

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

  async heartbeat(input: HeartbeatInput): Promise<boolean> {
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs).toISOString();
    return this.store.heartbeat(input.businessId, input.runId, input.owner, {
      expectedVersion: input.expectedVersion,
      leaseExpiresAt,
    });
  }

  async release(input: ReleaseInput): Promise<boolean> {
    assertRunTransition(input.expectedStatus, input.status);
    return this.store.transitionRun(input.businessId, input.runId, {
      expectedVersion: input.expectedVersion,
      expectedStatus: input.expectedStatus,
      status: input.status,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(input.errorEvidenceRef === undefined ? {} : { errorEvidenceRef: input.errorEvidenceRef }),
    });
  }

  async reclaimExpired(input: ReclaimInput): Promise<readonly PersistedRun[]> {
    return this.store.reclaimExpiredRuns(input.businessId, input.now.toISOString(), input.limit);
  }

  /**
   * Returns Runs a crashed handler parked at `needs_reconciliation` to `queued`. Nothing else
   * moves a Run out of that status, so without this the Run is parked for good.
   */
  async requeueParked(input: {
    businessId: string;
    limit: number;
  }): Promise<readonly PersistedRun[]> {
    return this.store.requeueParkedRuns(input.businessId, input.limit);
  }

  async claimBatch(input: ClaimBatchInput): Promise<readonly PersistedRun[]> {
    return this.store.claimNextQueued(input.businessId, input.owner, {
      now: input.now.toISOString(),
      leaseDurationMs: input.leaseDurationMs,
      limit: input.limit,
    });
  }
}
