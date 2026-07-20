import type { PgBoss } from "pg-boss";
import type { ApprovalsRepo } from "../approvals/repo";
import type { RoutineRunDriver } from "./driver";
import type { RoutineRunsRepo } from "./repo";

export const ROUTINE_RUN_QUEUE = "routine-run";
export const ROUTINE_WAKE_QUEUE = "routine-wake";
export const ROUTINE_SWEEP_QUEUE = "routine-sweep";
/** Sweep cadence: heal missed wakes / expired deadlines every 5 minutes. */
export const ROUTINE_SWEEP_CRON = "*/5 * * * *";
/** A running run with no heartbeat for this long is presumed crashed mid-state. */
export const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

export interface RoutineRunJob {
  runId: string;
  slug: string;
  trigger: { type: string; payload?: unknown; triggerIndex?: number };
}

export interface RoutineWakeJob {
  runId: string;
  reason: "sleep" | "retry" | "approval";
  token: string;
  decision?: "approved" | "denied";
}

type JobsLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export interface RoutineJobsDeps {
  driver: RoutineRunDriver;
  runs: RoutineRunsRepo;
  /** Enables approval expiry in the sweep (routine_state rows past expires_at → timeout). */
  approvals?: ApprovalsRepo;
  log: JobsLogger;
}

/** Producer helpers — threaded into routes/tools so they can enqueue without pg-boss types. */
export interface RoutineEnqueuers {
  enqueueRun(job: RoutineRunJob): Promise<void>;
  enqueueWake(job: RoutineWakeJob & { startAfter?: Date }): Promise<void>;
}

export function makeRoutineEnqueuers(boss: PgBoss): RoutineEnqueuers {
  return {
    async enqueueRun(job) {
      await boss.send(ROUTINE_RUN_QUEUE, job as unknown as object, {
        singletonKey: `run:${job.runId}`,
      });
    },
    async enqueueWake(job) {
      const { startAfter, ...data } = job;
      await boss.send(ROUTINE_WAKE_QUEUE, data as unknown as object, {
        singletonKey: `wake:${job.runId}:${job.token}`,
        ...(startAfter ? { startAfter } : {}),
      });
    },
  };
}

/**
 * Registers the routine engine's pg-boss queues (D4): `routine-run` (fresh runs),
 * `routine-wake` (sleep/retry/approval resumptions, delayed jobs) and the
 * `routine-sweep` cron that heals the persist-first/enqueue-second crash window by
 * re-enqueueing any run whose `wake_at` passed without a wake firing.
 */
export async function registerRoutineJobs(boss: PgBoss, deps: RoutineJobsDeps): Promise<void> {
  const { driver, runs, log } = deps;
  const enqueuers = makeRoutineEnqueuers(boss);

  await boss.createQueue(ROUTINE_RUN_QUEUE);
  await boss.createQueue(ROUTINE_WAKE_QUEUE);
  await boss.createQueue(ROUTINE_SWEEP_QUEUE);

  await boss.work(ROUTINE_RUN_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as unknown as RoutineRunJob;
      try {
        await driver.drive(data.runId);
      } catch (err) {
        log.error({ err, runId: data.runId }, "routine run failed unexpectedly");
        throw err;
      }
    }
  });

  await boss.work(ROUTINE_WAKE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as unknown as RoutineWakeJob;
      try {
        await driver.drive(data.runId, {
          approvalOutcome: data.reason === "approval" ? data.decision : undefined,
        });
      } catch (err) {
        log.error({ err, runId: data.runId }, "routine wake failed unexpectedly");
        throw err;
      }
    }
  });

  await boss.work(ROUTINE_SWEEP_QUEUE, async () => {
    const now = new Date();
    const overdue = await runs.listOverdueWakes(now);
    for (const run of overdue) {
      await enqueuers.enqueueWake({
        runId: run.id,
        reason: "sleep",
        token: `sweep:${run.wakeAt?.getTime() ?? now.getTime()}`,
      });
    }
    // Cross-restart state timeouts: a `running` run whose state_deadline passed AND
    // whose heartbeat is stale lost its process mid-state. Re-enter via drive() — the
    // state re-executes and the engine's in-process timeout/onErrors routing applies.
    const staleCutoff = new Date(now.getTime() - STALE_HEARTBEAT_MS);
    const expired = (await runs.listExpiredDeadlines(now)).filter(
      (run) => run.updatedAt < staleCutoff
    );
    for (const run of expired) {
      await enqueuers.enqueueWake({
        runId: run.id,
        reason: "sleep",
        token: `deadline:${run.stateDeadline?.getTime() ?? now.getTime()}`,
      });
    }
    // Expired routine approvals: settle as timeout and wake the run with a denial so
    // the state routes through its onErrors (or fails) instead of waiting forever.
    if (deps.approvals) {
      const expiredApprovals = await deps.approvals.listExpiredPending("routine_state", now);
      for (const row of expiredApprovals) {
        await deps.approvals.settle(row.id, "timeout");
        const payload = (row.payload ?? {}) as { runId?: string };
        if (payload.runId) {
          await enqueuers.enqueueWake({
            runId: payload.runId,
            reason: "approval",
            token: `approval-timeout:${row.id}`,
            decision: "denied",
          });
        }
      }
      if (expiredApprovals.length > 0) {
        log.warn({ count: expiredApprovals.length }, "routine sweep timed out expired approvals");
      }
    }
    if (overdue.length + expired.length > 0) {
      log.warn(
        { overdue: overdue.length, expiredDeadlines: expired.length },
        "routine sweep re-enqueued stuck runs"
      );
    }
  });
  await boss.schedule(ROUTINE_SWEEP_QUEUE, ROUTINE_SWEEP_CRON);
}
