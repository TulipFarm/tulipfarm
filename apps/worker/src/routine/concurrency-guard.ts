import {
  acquireStateConcurrencyKey,
  type CompiledState,
  planStateConcurrencyBackoffWait,
  type RegisterWaitInput,
  routineConcurrencyWaitId,
  STATE_CONCURRENCY_MAX_WAITS,
  type StateConcurrencyStore,
  type StateContentionStore,
  type StateStatus,
  stateConcurrencyBackoffMs,
} from "@tulipfarm/run-kernel";
import type { PersistedRun, PersistedWait } from "@tulipfarm/storage";

/**
 * Mutual exclusion for a Routine State's authored `concurrencyKey`, and the queue in front of it.
 *
 * Two rules hold this together and neither survives alone. A State that cannot get the key never
 * runs, because running it would deliver exactly the parallelism the author wrote the key to
 * prevent. And a State that cannot get the key does not become an operator's problem either: it
 * queues on a durable timer, because nothing requeues a Run parked at `needs_reconciliation`, so
 * parking on contention built the queue out of human attention.
 */

/** Park reason for a State whose key stayed held past every backoff it was allowed. */
export const CONCURRENCY_BUSY = "concurrency_key_busy";

/** The durable-wait surface the guard needs; the executor owns the full port. */
interface GuardWaitPort {
  register(input: RegisterWaitInput): Promise<{ readonly wait: PersistedWait }>;
  find(businessId: string, waitId: string): Promise<PersistedWait | null>;
}

export interface ConcurrencyGuardContext {
  readonly run: PersistedRun;
  readonly concurrency: StateConcurrencyStore;
  readonly contention: StateContentionStore;
  readonly waits: GuardWaitPort;
  readonly now: () => Date;
  readonly delay: (ms: number) => Promise<void>;
  /** Moves the State row. The executor owns the transition port and its CAS. */
  readonly transition: (
    key: string,
    from: StateStatus,
    to: StateStatus,
    reason?: string
  ) => Promise<void>;
}

/** Durable count of backoff waits this State occurrence has already spent on its key. */
async function contentionWaits(ctx: ConcurrencyGuardContext, key: string): Promise<number> {
  const loaded = await ctx.contention.load(ctx.run.businessId, ctx.run.id, key);
  return loaded?.waits ?? 0;
}

/**
 * Whether a `waiting` row is a concurrency backoff whose timer has fired, and so must resume
 * *into* execution rather than past it.
 *
 * `wait` and `approval` States never enter the guard, so their `waiting` row is always their own
 * wait and their resume must stay the skip-forward one: a satisfied wait meaning "the State
 * succeeded" is right for a State whose whole body was the waiting, and wrong for anything else.
 * The durable counter, not the State type, is the record that a backoff was opened.
 */
export async function concurrencyBackoffElapsed(
  ctx: ConcurrencyGuardContext,
  state: CompiledState,
  key: string
): Promise<boolean> {
  if (state.type === "wait" || state.type === "approval") return false;
  const spent = await contentionWaits(ctx, key);
  if (spent === 0) return false;
  const wait = await ctx.waits.find(
    ctx.run.businessId,
    routineConcurrencyWaitId(ctx.run.id, key, spent)
  );
  return wait !== null && wait.status !== "pending";
}

/**
 * Queues a contender on a durable timer instead of handing it to an operator.
 *
 * The State goes `waiting` *without* the key, the Run releases its lease, and the deadline sweep
 * that already exists requeues it — so the waiting is durable and happens outside this Run's own
 * claim rather than in memory inside it. On resume the State re-enters {@link underConcurrencyKey}
 * and must acquire the key before any work runs; no path from a fired backoff reaches the State's
 * effect without acquisition.
 *
 * The budget is bounded and durable. A contender that exhausts {@link STATE_CONCURRENCY_MAX_WAITS}
 * parks exactly as it did before, because an unbounded retry chain is a livelock wearing a queue's
 * clothes. Ordering is not preserved and starvation is therefore possible: a repeatedly unlucky
 * contender can spend its budget while later arrivals take the key. That is accepted — the
 * alternative is a durable ordered queue whose head is a Run that may itself crash, and the
 * ceiling turns starvation into a bounded, named park rather than an unbounded wait.
 */
async function queueOnContention(
  ctx: ConcurrencyGuardContext,
  key: string
): Promise<"waiting" | "needs_reconciliation"> {
  const spent = await contentionWaits(ctx, key);

  // A worker that died between opening a backoff and parking on it finds its own wait here.
  if (spent >= 1) {
    const open = await ctx.waits.find(
      ctx.run.businessId,
      routineConcurrencyWaitId(ctx.run.id, key, spent)
    );
    if (open !== null && open.status === "pending") {
      await ctx.transition(key, "running", "waiting");
      return "waiting";
    }
  }
  if (spent >= STATE_CONCURRENCY_MAX_WAITS) {
    await ctx.transition(key, "running", "needs_reconciliation", `routine:${CONCURRENCY_BUSY}`);
    return "needs_reconciliation";
  }

  const attempt = spent + 1;
  // Recorded before the wait it pays for exists, so a crash in between spends the budget rather
  // than refunding it — the same ordering the durable retry counter uses.
  await ctx.contention.record({
    businessId: ctx.run.businessId,
    runId: ctx.run.id,
    stateKey: key,
    waits: attempt,
  });
  await ctx.waits.register(
    planStateConcurrencyBackoffWait({
      businessId: ctx.run.businessId,
      runId: ctx.run.id,
      waitId: routineConcurrencyWaitId(ctx.run.id, key, attempt),
      stateKey: key,
      now: ctx.now().toISOString(),
      delayMs: stateConcurrencyBackoffMs(attempt, `${ctx.run.id}:${key}`),
    })
  );
  await ctx.transition(key, "running", "waiting");
  return "waiting";
}

async function releaseKey(
  ctx: ConcurrencyGuardContext,
  concurrencyKey: string,
  stateKey: string
): Promise<void> {
  try {
    await ctx.concurrency.release(ctx.run.businessId, concurrencyKey, ctx.run.id, stateKey);
  } catch {
    // A failed release must never mask the State's own outcome, and it is not a correctness hole:
    // the lease expires on its own, which is the same path a crashed holder takes.
  }
}

/**
 * Runs a State's work while holding its authored `concurrencyKey`, if it declared one.
 *
 * The lease is durable, so contenders in other worker processes are serialized rather than merely
 * ordered within this one. Acquisition blocks in process for a bounded window and, if the key is
 * still held, hands off to the durable queue. `wait` and `approval` States are deliberately
 * outside this guard — they return before doing work, and holding a lock across a durable park
 * would block every contender for as long as a human takes to answer.
 *
 * Release is best-effort by construction: a worker that dies mid-State never reaches it. The
 * lease's expiry, not this call, is what stops a crash from wedging the key forever.
 */
export async function underConcurrencyKey<T>(
  ctx: ConcurrencyGuardContext,
  state: CompiledState,
  key: string,
  work: () => Promise<T>
): Promise<T | "waiting" | "needs_reconciliation"> {
  const concurrencyKey = state.concurrencyKey;
  if (concurrencyKey === null) return work();

  const acquisition = await acquireStateConcurrencyKey({
    store: ctx.concurrency,
    businessId: ctx.run.businessId,
    concurrencyKey,
    runId: ctx.run.id,
    stateKey: key,
    runLeaseExpiresAt: ctx.run.leaseExpiresAt,
    now: ctx.now,
    delay: ctx.delay,
  });
  if (acquisition === "busy") return queueOnContention(ctx, key);

  try {
    return await work();
  } finally {
    // A nested State under an outer holder of the same key never took the lease, so releasing
    // here would drop the exclusion the outer State is still relying on.
    if (acquisition === "acquired") await releaseKey(ctx, concurrencyKey, key);
  }
}
