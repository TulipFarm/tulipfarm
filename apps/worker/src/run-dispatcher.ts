import type { RunLeaseManager } from "@tulipfarm/run-kernel";
import type { PersistedRun } from "@tulipfarm/storage";
import type { RunOutcome } from "@tulipfarm/turn-executor";

export type { RunOutcome } from "@tulipfarm/turn-executor";

export interface RunDispatcherOptions {
  leases: RunLeaseManager;
  businessId: string;
  owner: string;
  handler: (run: PersistedRun) => Promise<RunOutcome>;
  /**
   * Fired after a Run durably reaches `succeeded` or `failed`, so a parent parked on it can be
   * resumed. Never fired for `waiting`, `cancelled`, or `needs_reconciliation` — those Runs are
   * still live and belong to the cancellation manager or the reconciler.
   */
  onTerminal?: (run: PersistedRun, status: "succeeded" | "failed") => Promise<void>;
  /**
   * Fired after a Run durably reaches `waiting`, so a wait that resolved while it was still
   * `running` can be claimed.
   *
   * Ordering is the whole point: a requeue is guarded on `runs.status = 'waiting'`, so anything
   * that tries to wake a Run before this transition commits silently requeues nothing. This is
   * the first moment the Run is reachable, which makes it the only safe place to ask.
   */
  onWaiting?: (run: PersistedRun) => Promise<void>;
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
        if (outcome === "succeeded" || outcome === "failed") {
          await this.notifyTerminal(started.run, outcome);
        }
        if (outcome === "waiting") {
          await this.notifyWaiting(started.run);
        }
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

  /**
   * The Run is already durably terminal here, so a throwing hook must not reopen it — the parked
   * parent degrades to expiring on its own deadline, which the wait sweeper already handles.
   */
  private async notifyTerminal(run: PersistedRun, status: "succeeded" | "failed"): Promise<void> {
    if (!this.options.onTerminal) return;
    try {
      await this.options.onTerminal(run, status);
    } catch {
      // Intentionally swallowed; see above.
    }
  }

  /**
   * The Run is durably parked here, so a throwing hook leaves it parked rather than breaking it.
   * That degrades to the wait's own deadline, which is the same floor every other park has.
   */
  private async notifyWaiting(run: PersistedRun): Promise<void> {
    if (!this.options.onWaiting) return;
    try {
      await this.options.onWaiting(run);
    } catch {
      // Intentionally swallowed; see above.
    }
  }
}
