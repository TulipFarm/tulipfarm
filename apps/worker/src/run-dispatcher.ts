import type { RunLeaseManager } from "@tulipfarm/run-kernel";
import type { PersistedRun } from "@tulipfarm/storage";
import type { RunOutcome } from "@tulipfarm/turn-executor";

export type { RunOutcome } from "@tulipfarm/turn-executor";

export interface RunDispatcherOptions {
  leases: RunLeaseManager;
  businessId: string;
  owner: string;
  handler: (run: PersistedRun) => Promise<RunOutcome>;
  now: () => Date;
  leaseDurationMs?: number;
  batchSize?: number;
}

export interface DispatchRunsResult {
  reclaimed: number;
  claimed: number;
  dispatched: number;
  /** Runs parked on a durable wait, plus those left to the cancellation manager. */
  waiting: number;
  failed: number;
}

/** Claims a batch of due Runs and drives each through `running` to a terminal outcome. */
export class RunDispatcher {
  constructor(private readonly options: RunDispatcherOptions) {}

  async dispatchBatch(): Promise<DispatchRunsResult> {
    const limit = this.options.batchSize ?? 25;
    const leaseDurationMs = this.options.leaseDurationMs ?? 60_000;

    const reclaimed = await this.options.leases.reclaimExpired({
      businessId: this.options.businessId,
      now: this.options.now(),
      limit,
    });

    const claimed = await this.options.leases.claimBatch({
      businessId: this.options.businessId,
      owner: this.options.owner,
      now: this.options.now(),
      leaseDurationMs,
      limit,
    });

    let dispatched = 0;
    let waiting = 0;
    let failed = 0;
    for (const run of claimed) {
      const started = await this.options.leases.claim({
        businessId: this.options.businessId,
        runId: run.id,
        owner: this.options.owner,
        now: this.options.now(),
        leaseDurationMs,
        expectedVersion: run.version,
        expectedStatus: "claimed",
        status: "running",
      });
      if (!started.claimed || !started.run) continue;

      try {
        const outcome = await this.options.handler(started.run);
        if (outcome === "cancelled") {
          // Cancellation manager owns this transition; do not race it here.
          waiting += 1;
          continue;
        }
        const released = await this.options.leases.release({
          businessId: this.options.businessId,
          runId: run.id,
          expectedVersion: started.run.version,
          expectedStatus: "running",
          status: outcome,
        });
        if (!released) {
          failed += 1;
          continue;
        }
        if (outcome === "succeeded") dispatched += 1;
        else if (outcome === "waiting") waiting += 1;
        else failed += 1;
      } catch {
        await this.options.leases.release({
          businessId: this.options.businessId,
          runId: run.id,
          expectedVersion: started.run.version,
          expectedStatus: "running",
          status: "needs_reconciliation",
        });
        failed += 1;
      }
    }

    return { reclaimed: reclaimed.length, claimed: claimed.length, dispatched, waiting, failed };
  }
}
