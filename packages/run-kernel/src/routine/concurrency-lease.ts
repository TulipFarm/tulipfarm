/**
 * Durable mutual exclusion for a Routine State's authored `concurrencyKey`.
 *
 * An author who writes `concurrencyKey` is asking for work not to overlap. Nothing enforced that
 * before, so two Runs that named the same key ran their States in parallel — the schema promised
 * serialization and the executor delivered none.
 *
 * The lease is durable because contenders live in different worker processes, and it carries an
 * expiry because release cannot be made crash-safe: a worker that dies mid-State never runs its
 * release, and a lease with no expiry would wedge that key for every future Run. Expiry bounds the
 * damage of a crash to one lease term instead of forever, which is the trade a lock over a
 * crashable process has to make. It is deliberately *not* the same table as `run_concurrency_slots`
 * (SPEC §9.1 target admission): that is keyed per Run, so it cannot serialize two States of one
 * Run, and it has no expiry.
 */

import { createHash } from "node:crypto";
import type { RegisterWaitInput } from "../waits";

/** Who holds a key, and until when. `stateKey` is the State occurrence, not the authored name. */
export interface StateConcurrencyLease {
  readonly businessId: string;
  readonly concurrencyKey: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly expiresAt: string;
}

export interface AcquireStateConcurrencyInput {
  readonly businessId: string;
  readonly concurrencyKey: string;
  readonly runId: string;
  readonly stateKey: string;
  /** Anything expiring at or before this instant is a dead holder and may be taken. */
  readonly now: string;
  readonly expiresAt: string;
}

/**
 * `reentrant` means this Run already holds the key under a different State occurrence — a nested
 * fan-out body under an outer State that named the same key. Taking it again would be a
 * self-deadlock, and releasing it from the inner scope would drop the outer State's exclusion, so
 * the inner scope neither takes nor releases.
 */
export type StateConcurrencyAcquisition =
  | { readonly kind: "acquired" }
  | { readonly kind: "reentrant" }
  | { readonly kind: "busy"; readonly heldByRunId: string };

export interface StateConcurrencyStore {
  acquire(input: AcquireStateConcurrencyInput): Promise<StateConcurrencyAcquisition>;
  /** Frees the key only when this exact holder still owns it; a stolen lease is left alone. */
  release(
    businessId: string,
    concurrencyKey: string,
    runId: string,
    stateKey: string
  ): Promise<boolean>;
}

/** How long a taken lease stays valid without renewal. Matches the worker's default Run lease. */
export const STATE_CONCURRENCY_LEASE_MS = 60_000;

/** Gap between acquisition attempts while a key is held by a live contender. */
export const STATE_CONCURRENCY_POLL_MS = 250;

/**
 * Total time a State may block *in process* waiting for a contended key. Held well under the Run
 * lease so a queue of contenders cannot strand the lease the Run is executing under; a State still
 * waiting after this hands off to a durable backoff (see {@link stateConcurrencyBackoffMs}) rather
 * than either running unserialized or sleeping past its own claim.
 */
export const STATE_CONCURRENCY_WAIT_MS = 5_000;

/** Attempts an acquisition makes before it reports the key busy. */
export const STATE_CONCURRENCY_ATTEMPTS = Math.max(
  1,
  Math.ceil(STATE_CONCURRENCY_WAIT_MS / STATE_CONCURRENCY_POLL_MS)
);

/** In-memory `StateConcurrencyStore` for tests and the executor's non-durable default. */
export class InMemoryStateConcurrencyStore implements StateConcurrencyStore {
  private readonly leases = new Map<string, StateConcurrencyLease>();

  private key(businessId: string, concurrencyKey: string): string {
    return `${businessId}\u0000${concurrencyKey}`;
  }

  async acquire(input: AcquireStateConcurrencyInput): Promise<StateConcurrencyAcquisition> {
    const mapKey = this.key(input.businessId, input.concurrencyKey);
    const held = this.leases.get(mapKey);
    const expired = held !== undefined && Date.parse(held.expiresAt) <= Date.parse(input.now);
    const mine = held?.runId === input.runId && held?.stateKey === input.stateKey;

    if (held !== undefined && !expired && !mine) {
      if (held.runId === input.runId) return { kind: "reentrant" };
      return { kind: "busy", heldByRunId: held.runId };
    }
    this.leases.set(mapKey, {
      businessId: input.businessId,
      concurrencyKey: input.concurrencyKey,
      runId: input.runId,
      stateKey: input.stateKey,
      expiresAt: input.expiresAt,
    });
    return { kind: "acquired" };
  }

  async release(
    businessId: string,
    concurrencyKey: string,
    runId: string,
    stateKey: string
  ): Promise<boolean> {
    const mapKey = this.key(businessId, concurrencyKey);
    const held = this.leases.get(mapKey);
    if (held === undefined || held.runId !== runId || held.stateKey !== stateKey) return false;
    this.leases.delete(mapKey);
    return true;
  }
}

/**
 * When a taken lease should expire. A lease shorter than the holder Run's own lease would let a
 * peer steal a key the holder is still legitimately executing under, so the Run's lease expiry
 * wins whenever it is the later of the two.
 */
export function stateConcurrencyExpiry(now: Date, runLeaseExpiresAt: string | null): string {
  const floor = now.getTime() + STATE_CONCURRENCY_LEASE_MS;
  const runLease = runLeaseExpiresAt === null ? Number.NaN : Date.parse(runLeaseExpiresAt);
  const chosen = Number.isFinite(runLease) && runLease > floor ? runLease : floor;
  return new Date(chosen).toISOString();
}

export interface AcquireStateConcurrencyKeyInput {
  readonly store: StateConcurrencyStore;
  readonly businessId: string;
  readonly concurrencyKey: string;
  readonly runId: string;
  readonly stateKey: string;
  /** The holder Run's lease expiry; bounds how long a crashed holder can hold the key. */
  readonly runLeaseExpiresAt: string | null;
  readonly now: () => Date;
  readonly delay: (ms: number) => Promise<void>;
}

/**
 * Takes a key, waiting out a live contender for at most {@link STATE_CONCURRENCY_WAIT_MS}.
 *
 * The wait is bounded by attempts rather than by clock reading so an injected clock cannot spin
 * it forever. `busy` is a real answer, not a failure: the caller must refuse to run the State
 * rather than run it unserialized.
 */
export async function acquireStateConcurrencyKey(
  input: AcquireStateConcurrencyKeyInput
): Promise<StateConcurrencyAcquisition["kind"]> {
  for (let attempt = 1; attempt <= STATE_CONCURRENCY_ATTEMPTS; attempt += 1) {
    const at = input.now();
    const result = await input.store.acquire({
      businessId: input.businessId,
      concurrencyKey: input.concurrencyKey,
      runId: input.runId,
      stateKey: input.stateKey,
      now: at.toISOString(),
      expiresAt: stateConcurrencyExpiry(at, input.runLeaseExpiresAt),
    });
    if (result.kind !== "busy") return result.kind;
    if (attempt < STATE_CONCURRENCY_ATTEMPTS) await input.delay(STATE_CONCURRENCY_POLL_MS);
  }
  return "busy";
}

/**
 * How many durable backoff waits one State occurrence may open before it gives up.
 *
 * A retry chain with no ceiling is a livelock wearing a queue's clothes, so the count is bounded
 * and the bound is durable. A contender that exhausts it parks at `needs_reconciliation` exactly
 * as it used to — parking is still the terminal answer, it has just stopped being the *first* one.
 */
export const STATE_CONCURRENCY_MAX_WAITS = 6;

/** First durable backoff. Doubles per wait, clamped by {@link STATE_CONCURRENCY_MAX_BACKOFF_MS}. */
export const STATE_CONCURRENCY_BACKOFF_MS = 1_000;

/** Ceiling on one backoff, mirroring the retry backoff clamp so no single wait dominates. */
export const STATE_CONCURRENCY_MAX_BACKOFF_MS = 30_000;

/** Schema reference of a backoff timer. Deliberately not a State's own output schema. */
export const STATE_CONCURRENCY_BACKOFF_SCHEMA_REF = "wait:timer:concurrency-backoff";

/**
 * Delay before a contender's `attempt`-th re-acquisition (`attempt >= 1`).
 *
 * Exponential so a long-held key is not re-probed at a fixed rate, and jittered because every
 * contender on one key is woken by the same release: identical delays would rebuild the contention
 * they are backing off from. The jitter is derived from the contender's own identity rather than a
 * random source, so two Runs get different delays while one Run replaying after a crash recomputes
 * the delay it already committed to.
 *
 * Summed over {@link STATE_CONCURRENCY_MAX_WAITS} waits the durable ceiling is 30.5s–61s; with the
 * in-process {@link STATE_CONCURRENCY_WAIT_MS} spent before each acquisition the total a contender
 * can spend queueing is under two minutes, after which it parks.
 */
export function stateConcurrencyBackoffMs(attempt: number, seed: string): number {
  if (attempt < 1) return 0;
  const raw = Math.min(
    STATE_CONCURRENCY_BACKOFF_MS * 2 ** (attempt - 1),
    STATE_CONCURRENCY_MAX_BACKOFF_MS
  );
  const digest = createHash("sha256").update(`${seed}:${attempt}`).digest();
  const fraction = digest.readUInt32BE(0) / 0x1_0000_0000;
  return Math.max(1, Math.round(raw * (0.5 + fraction / 2)));
}

export interface StateConcurrencyBackoffContext {
  readonly businessId: string;
  readonly runId: string;
  readonly waitId: string;
  readonly stateKey: string;
  readonly now: string;
  readonly delayMs: number;
}

/**
 * Plan the timer a contended State parks on. Performs no I/O, so a crash between planning and
 * registration replays to the same plan under the same wait id.
 */
export function planStateConcurrencyBackoffWait(
  ctx: StateConcurrencyBackoffContext
): RegisterWaitInput {
  return {
    id: ctx.waitId,
    businessId: ctx.businessId,
    runId: ctx.runId,
    stateKey: ctx.stateKey,
    kind: "timer",
    aggregation: "first",
    schemaRef: STATE_CONCURRENCY_BACKOFF_SCHEMA_REF,
    allowedPrincipals: [],
    expectedSignals: 1,
    quorum: null,
    deadlineAt: new Date(Date.parse(ctx.now) + Math.max(1, ctx.delayMs)).toISOString(),
    createdAt: ctx.now,
  };
}

/** How many backoff waits a State occurrence has already opened on its contended key. */
export interface StateContentionWaits {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly waits: number;
}

/**
 * Durable home for a contender's spent backoff budget.
 *
 * The counter has to outlive the park it pays for: a State that reloaded zero on every resume
 * would be handed a fresh ceiling each time and could queue forever, which is the non-durable
 * counter bug L3-2 closed one layer down. `record` is therefore the same monotonic upsert — a
 * counter only ever climbs, so a stale or racing writer cannot refund a wait already taken.
 */
export interface StateContentionStore {
  load(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<StateContentionWaits | undefined>;
  record(input: StateContentionWaits): Promise<void>;
}

/** In-memory `StateContentionStore` for tests and the executor's non-durable default. */
export class InMemoryStateContentionStore implements StateContentionStore {
  private readonly counts = new Map<string, number>();

  private key(businessId: string, runId: string, stateKey: string): string {
    return `${businessId}\u0000${runId}\u0000${stateKey}`;
  }

  async load(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<StateContentionWaits | undefined> {
    const waits = this.counts.get(this.key(businessId, runId, stateKey));
    if (waits === undefined) return undefined;
    return { businessId, runId, stateKey, waits };
  }

  async record(input: StateContentionWaits): Promise<void> {
    const mapKey = this.key(input.businessId, input.runId, input.stateKey);
    const current = this.counts.get(mapKey) ?? 0;
    this.counts.set(mapKey, Math.max(current, input.waits));
  }
}
