import type { LoopCheckpointStore } from "@tulipfarm/agent-runtime";
import type { RunLeaseManager, RunRecoveryManager } from "@tulipfarm/run-kernel";
import {
  DISPATCH_HANDLER_ERROR_REF,
  DISPATCH_REQUEUE_EXHAUSTED_REF,
  DISPATCH_REQUEUED_ONCE_REF,
  DISPATCH_UNSPECIFIED_PARK_REF,
  type PersistedRun,
} from "@tulipfarm/storage";
import type { RunOutcome } from "@tulipfarm/turn-executor";

export type { RunOutcome, RunOutcomeStatus } from "@tulipfarm/turn-executor";

export interface RunDispatcherOptions {
  leases: RunLeaseManager;
  recovery?: Pick<RunRecoveryManager, "sweep">;
  businessId: string;
  owner: string;
  handler: (run: PersistedRun, signal: AbortSignal) => Promise<RunOutcome>;
  /** Retires terminal delivery only after the Run transition is durable. */
  checkpoints?: Pick<LoopCheckpointStore, "settle">;
  /** Process drain signal. An active handler is aborted and its lease is left to expire safely. */
  signal?: AbortSignal;
  /**
   * Reports a handler throw that parked its Run at `needs_reconciliation`. Optional so existing
   * callers and tests need not wire one, but production always does — an unrecorded throw here is
   * unrecoverable information (the Run's own event ledger never sees it).
   */
  log?: { error(message: string, error?: unknown): void };
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
  /** Abandoned Runs whose durable effects proved replay-safe, returned to the queue. */
  requeuedParked: number;
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

    const recovered = await this.options.recovery?.sweep({
      businessId: this.options.businessId,
      limit,
    });

    let claimed = 0;
    let dispatched = 0;
    let waiting = 0;
    let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      if (this.options.signal?.aborted === true) break;
      const next = await this.options.leases.claimBatch({
        businessId: this.options.businessId,
        owner: this.options.owner,
        now: this.options.now(),
        leaseDurationMs,
        limit: 1,
      });
      const run = next[0];
      if (run === undefined) break;
      claimed += 1;
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

      const execution = await this.executeOwned(started.run, leaseDurationMs);
      if (execution.kind === "lease_lost") {
        failed += 1;
        break;
      }
      const { version } = execution;
      if (execution.kind === "outcome") {
        const outcome = execution.outcome;
        if (outcome.status === "cancelled") {
          // Cancellation manager owns this transition; do not race it here.
          waiting += 1;
          continue;
        }
        // A Run already requeued once that parks again (without throwing) would otherwise carry
        // no evidence ref and sit invisible to the sweep forever; fail it outright instead, same
        // as the throwing path below.
        const exhaustedPark =
          outcome.status === "needs_reconciliation" &&
          started.run.errorEvidenceRef === DISPATCH_REQUEUED_ONCE_REF;
        const releaseStatus = exhaustedPark ? "failed" : outcome.status;
        const releaseEvidenceRef = exhaustedPark
          ? DISPATCH_REQUEUE_EXHAUSTED_REF
          : (outcome.errorEvidenceRef ??
            (outcome.status === "needs_reconciliation"
              ? DISPATCH_UNSPECIFIED_PARK_REF
              : undefined));
        const released = await this.options.leases.release({
          businessId: this.options.businessId,
          runId: run.id,
          expectedVersion: version,
          expectedStatus: "running",
          status: releaseStatus,
          now: this.options.now(),
          ...(releaseEvidenceRef === undefined ? {} : { errorEvidenceRef: releaseEvidenceRef }),
        });
        if (!released) {
          failed += 1;
          continue;
        }
        if (releaseStatus === "succeeded") dispatched += 1;
        else if (releaseStatus === "waiting") waiting += 1;
        else failed += 1;
        const settledRun: PersistedRun = {
          ...started.run,
          status: releaseStatus,
          version: version + 1,
          leaseOwner: null,
          leaseExpiresAt: null,
          ...(releaseStatus === "succeeded" || releaseStatus === "failed"
            ? { finishedAt: this.options.now().toISOString() }
            : {}),
          ...(releaseEvidenceRef === undefined ? {} : { errorEvidenceRef: releaseEvidenceRef }),
        };
        if (releaseStatus === "succeeded" || releaseStatus === "failed") {
          await this.clearTerminalCheckpoints(settledRun);
          await this.notifyTerminal(settledRun, releaseStatus);
        }
        if (releaseStatus === "waiting") {
          await this.notifyWaiting(settledRun);
        }
      } else {
        const error = execution.error;
        // A Run already requeued once has now thrown twice. Parking it again would put it straight
        // back in front of the sweep it just came from, so it fails here with the reason recorded.
        const exhausted = started.run.errorEvidenceRef === DISPATCH_REQUEUED_ONCE_REF;
        const status = exhausted ? "failed" : "needs_reconciliation";
        this.options.log?.error(
          `run dispatch failed run=${run.id} business=${this.options.businessId} source=${run.source} — ${exhausted ? "already requeued once, failing" : "parking at needs_reconciliation"}`,
          error
        );
        const released = await this.options.leases.release({
          businessId: this.options.businessId,
          runId: run.id,
          expectedVersion: version,
          expectedStatus: "running",
          status,
          now: this.options.now(),
          errorEvidenceRef: exhausted ? DISPATCH_REQUEUE_EXHAUSTED_REF : DISPATCH_HANDLER_ERROR_REF,
        });
        if (released && exhausted) {
          const settledRun: PersistedRun = {
            ...started.run,
            status: "failed",
            version: version + 1,
            finishedAt: this.options.now().toISOString(),
            errorEvidenceRef: DISPATCH_REQUEUE_EXHAUSTED_REF,
            leaseOwner: null,
            leaseExpiresAt: null,
          };
          await this.clearTerminalCheckpoints(settledRun);
          await this.notifyTerminal(settledRun, "failed");
        }
        failed += 1;
      }
    }

    return {
      reclaimed: reclaimed.length,
      requeuedParked: recovered?.requeued ?? 0,
      claimed,
      dispatched,
      waiting,
      failed,
    };
  }

  private async executeOwned(
    run: PersistedRun,
    leaseDurationMs: number
  ): Promise<
    | { readonly kind: "outcome"; readonly outcome: RunOutcome; readonly version: number }
    | { readonly kind: "error"; readonly error: unknown; readonly version: number }
    | { readonly kind: "lease_lost" }
  > {
    const controller = new AbortController();
    const intervalMs = Math.max(1, Math.floor(leaseDurationMs / 3));
    let version = run.version;
    let stopped = false;
    let leaseLost = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: Promise<void> | undefined;
    let resolveLeaseLost: (() => void) | undefined;
    const lost = new Promise<{ readonly kind: "lease_lost" }>((resolve) => {
      resolveLeaseLost = () => resolve({ kind: "lease_lost" });
    });
    const loseLease = (reason?: unknown) => {
      if (leaseLost) return;
      leaseLost = true;
      controller.abort(reason);
      resolveLeaseLost?.();
    };
    const renew = async () => {
      const expectedVersion = version;
      const renewed = await this.options.leases.heartbeat({
        businessId: this.options.businessId,
        runId: run.id,
        owner: this.options.owner,
        now: this.options.now(),
        leaseDurationMs,
        expectedVersion,
      });
      if (!renewed) {
        loseLease("run_lease_lost");
        return;
      }
      version = expectedVersion + 1;
      if (!stopped) schedule();
    };
    const schedule = () => {
      timer = setTimeout(() => {
        heartbeat = renew().catch((error) => loseLease(error));
      }, intervalMs);
      timer.unref?.();
    };
    const onDrain = () => loseLease(this.options.signal?.reason);
    if (this.options.signal?.aborted === true) onDrain();
    else this.options.signal?.addEventListener("abort", onDrain, { once: true });
    if (leaseLost) {
      this.options.signal?.removeEventListener("abort", onDrain);
      return { kind: "lease_lost" };
    }
    schedule();

    try {
      const handled = Promise.resolve()
        .then(() => this.options.handler(run, controller.signal))
        .then(
          (outcome) => ({ kind: "outcome" as const, outcome }),
          (error: unknown) => ({ kind: "error" as const, error })
        );
      const first = await Promise.race([handled, lost]);
      stopped = true;
      if (leaseLost || first.kind === "lease_lost") return { kind: "lease_lost" };
      await heartbeat;
      if (leaseLost) return { kind: "lease_lost" };
      return { ...first, version };
    } finally {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      this.options.signal?.removeEventListener("abort", onDrain);
    }
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

  private async clearTerminalCheckpoints(run: PersistedRun): Promise<void> {
    if (!this.options.checkpoints) return;
    try {
      await this.options.checkpoints.settle(run.businessId, run.id, undefined, {
        leaseGeneration: run.leaseGeneration,
      });
    } catch (error) {
      this.options.log?.error(`terminal checkpoint cleanup failed run=${run.id}`, error);
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
