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
import { type RunLoopOptions, runLoop } from "./loop";

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
  /** Stops renewing one claimed execution so the normal reclaim path can resume it. */
  maxLifetimeMs?: number;
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

type NextRun =
  | { readonly kind: "empty" }
  | { readonly kind: "lost_claim" }
  | { readonly kind: "started"; readonly run: PersistedRun };

interface RunDispatchResult {
  readonly dispatched: number;
  readonly waiting: number;
  readonly failed: number;
  readonly leaseLost: boolean;
}

/** Claims a batch of due Runs and drives each through `running` to a terminal outcome. */
export class RunDispatcher {
  constructor(private readonly options: RunDispatcherOptions) {}

  async run(
    options: Pick<RunLoopOptions, "intervalMs" | "signal" | "logger" | "wait">
  ): Promise<void> {
    const active = new Set<Promise<void>>();
    const track = (run: PersistedRun, execution: Promise<RunDispatchResult>) => {
      let observed: Promise<void>;
      observed = execution
        .then(
          () => undefined,
          (error: unknown) => {
            options.logger.error(`worker Run execution failed run=${run.id}`, error);
          }
        )
        .finally(() => active.delete(observed));
      active.add(observed);
    };

    try {
      await runLoop({
        ...options,
        name: "run-dispatch",
        tick: async (signal) => {
          const limit = this.options.batchSize ?? 25;
          const leaseDurationMs = this.options.leaseDurationMs ?? 60_000;
          await this.recover(limit);

          for (let index = 0; index < limit; index += 1) {
            if (signal.aborted) break;
            const next = await this.claimNext(leaseDurationMs);
            if (next.kind === "empty") break;
            if (next.kind === "started") {
              track(next.run, this.dispatchStarted(next.run, leaseDurationMs, signal));
            }
          }
        },
      });
    } finally {
      await Promise.allSettled(active);
    }
  }

  async dispatchBatch(signal = this.options.signal): Promise<DispatchRunsResult> {
    const limit = this.options.batchSize ?? 25;
    const leaseDurationMs = this.options.leaseDurationMs ?? 60_000;
    const recovered = await this.recover(limit);

    let claimed = 0;
    let dispatched = 0;
    let waiting = 0;
    let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      if (signal?.aborted === true) break;
      const next = await this.claimNext(leaseDurationMs);
      if (next.kind === "empty") break;
      claimed += 1;
      if (next.kind === "lost_claim") continue;

      const result = await this.dispatchStarted(next.run, leaseDurationMs, signal);
      dispatched += result.dispatched;
      waiting += result.waiting;
      failed += result.failed;
      if (result.leaseLost) break;
    }

    return {
      reclaimed: recovered.reclaimed,
      requeuedParked: recovered.requeuedParked,
      claimed,
      dispatched,
      waiting,
      failed,
    };
  }

  private async recover(limit: number): Promise<{ reclaimed: number; requeuedParked: number }> {
    const reclaimed = await this.options.leases.reclaimExpired({
      businessId: this.options.businessId,
      now: this.options.now(),
      limit,
    });
    const recovered = await this.options.recovery?.sweep({
      businessId: this.options.businessId,
      limit,
    });
    return {
      reclaimed: reclaimed.length,
      requeuedParked: recovered?.requeued ?? 0,
    };
  }

  private async claimNext(leaseDurationMs: number): Promise<NextRun> {
    const candidates = await this.options.leases.claimBatch({
      businessId: this.options.businessId,
      owner: this.options.owner,
      now: this.options.now(),
      leaseDurationMs,
      limit: 1,
    });
    const candidate = candidates[0];
    if (candidate === undefined) return { kind: "empty" };
    const started = await this.options.leases.claim({
      businessId: this.options.businessId,
      runId: candidate.id,
      owner: this.options.owner,
      now: this.options.now(),
      leaseDurationMs,
      expectedVersion: candidate.version,
      expectedStatus: "claimed",
      status: "running",
    });
    if (!started.claimed || !started.run) return { kind: "lost_claim" };
    return { kind: "started", run: started.run };
  }

  private async dispatchStarted(
    run: PersistedRun,
    leaseDurationMs: number,
    signal: AbortSignal | undefined
  ): Promise<RunDispatchResult> {
    const execution = await this.executeOwned(run, leaseDurationMs, signal);
    if (execution.kind === "lease_lost") {
      return { dispatched: 0, waiting: 0, failed: 1, leaseLost: true };
    }
    const { version } = execution;
    if (execution.kind === "outcome") {
      const outcome = execution.outcome;
      if (outcome.status === "cancelled") {
        // Cancellation manager owns this transition; do not race it here.
        return { dispatched: 0, waiting: 1, failed: 0, leaseLost: false };
      }
      // A Run already requeued once that parks again (without throwing) would otherwise carry
      // no evidence ref and sit invisible to the sweep forever; fail it outright instead, same
      // as the throwing path below.
      const exhaustedPark =
        outcome.status === "needs_reconciliation" &&
        run.errorEvidenceRef === DISPATCH_REQUEUED_ONCE_REF;
      const releaseStatus = exhaustedPark ? "failed" : outcome.status;
      const releaseEvidenceRef = exhaustedPark
        ? DISPATCH_REQUEUE_EXHAUSTED_REF
        : (outcome.errorEvidenceRef ??
          (outcome.status === "needs_reconciliation" ? DISPATCH_UNSPECIFIED_PARK_REF : undefined));
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
        return { dispatched: 0, waiting: 0, failed: 1, leaseLost: false };
      }
      const settledRun: PersistedRun = {
        ...run,
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
      return {
        dispatched: releaseStatus === "succeeded" ? 1 : 0,
        waiting: releaseStatus === "waiting" ? 1 : 0,
        failed: releaseStatus === "succeeded" || releaseStatus === "waiting" ? 0 : 1,
        leaseLost: false,
      };
    }

    // A Run already requeued once has now thrown twice. Parking it again would put it straight
    // back in front of the sweep it just came from, so it fails here with the reason recorded.
    const exhausted = run.errorEvidenceRef === DISPATCH_REQUEUED_ONCE_REF;
    const status = exhausted ? "failed" : "needs_reconciliation";
    this.options.log?.error(
      `run dispatch failed run=${run.id} business=${this.options.businessId} source=${run.source} — ${exhausted ? "already requeued once, failing" : "parking at needs_reconciliation"}`,
      execution.error
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
        ...run,
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
    return { dispatched: 0, waiting: 0, failed: 1, leaseLost: false };
  }

  private async executeOwned(
    run: PersistedRun,
    leaseDurationMs: number,
    signal: AbortSignal | undefined
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
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveLeaseLost: (() => void) | undefined;
    let onDrain: (() => void) | undefined;
    const lost = new Promise<{ readonly kind: "lease_lost" }>((resolve) => {
      resolveLeaseLost = () => resolve({ kind: "lease_lost" });
    });
    const stopRenewal = () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    const stopOwnership = () => {
      stopRenewal();
      if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
      if (onDrain !== undefined) signal?.removeEventListener("abort", onDrain);
    };
    const loseLease = (reason?: unknown) => {
      if (leaseLost) return;
      leaseLost = true;
      stopOwnership();
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
    onDrain = () => loseLease(signal?.reason);
    if (signal?.aborted === true) onDrain();
    else signal?.addEventListener("abort", onDrain, { once: true });
    if (leaseLost) {
      return { kind: "lease_lost" };
    }
    if (this.options.maxLifetimeMs !== undefined) {
      lifetimeTimer = setTimeout(
        () => loseLease("run_max_lifetime_exceeded"),
        this.options.maxLifetimeMs
      );
      lifetimeTimer.unref?.();
    }
    schedule();

    const handled = Promise.resolve()
      .then(() => this.options.handler(run, controller.signal))
      .then(
        (outcome) => ({ kind: "outcome" as const, outcome }),
        (error: unknown) => ({ kind: "error" as const, error })
      );
    try {
      const first = await Promise.race([handled, lost]);
      stopRenewal();
      if (leaseLost || first.kind === "lease_lost") {
        await handled;
        return { kind: "lease_lost" };
      }
      await Promise.race([heartbeat ?? Promise.resolve(), lost]);
      if (leaseLost) {
        await handled;
        return { kind: "lease_lost" };
      }
      return { ...first, version };
    } finally {
      stopOwnership();
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
