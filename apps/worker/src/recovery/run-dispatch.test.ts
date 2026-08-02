import { RunLeaseManager } from "@tulipfarm/run-kernel";
import type { PersistedRun, PersistedRunStatus } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { RunDispatcher, type RunOutcome } from "../run-dispatcher";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const OWNER = "worker-1";
const SURVIVOR = "worker-2";
const T0 = new Date("2026-07-25T10:00:00.000Z");
const AFTER_LEASE = new Date("2026-07-25T10:05:00.000Z");

function run(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    id: RUN_ID,
    businessId: BUSINESS_ID,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    bounds: { wallTimeMs: 60_000, activeTimeMs: 30_000, attempts: 3, sideEffects: 2 },
    status: "queued",
    version: 0,
    createdAt: "2026-07-25T09:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

/** Run store with the CAS, lease-ownership, and expiry semantics the `runs` table enforces. */
class DurableRunStore {
  private readonly runs = new Map<string, PersistedRun>();
  readonly commits: Array<{ from: string; to: string }> = [];

  seed(overrides: Partial<PersistedRun> = {}): void {
    const seeded = run(overrides);
    this.runs.set(seeded.id, seeded);
  }

  async transitionRun(
    _businessId: string,
    runId: string,
    transition: {
      expectedVersion: number;
      expectedStatus: PersistedRunStatus;
      status: PersistedRunStatus;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
    }
  ): Promise<boolean> {
    const current = this.runs.get(runId);
    if (
      !current ||
      current.status !== transition.expectedStatus ||
      current.version !== transition.expectedVersion
    ) {
      return false;
    }
    this.runs.set(runId, {
      ...current,
      status: transition.status,
      version: current.version + 1,
      leaseOwner: transition.leaseOwner,
      leaseExpiresAt: transition.leaseExpiresAt,
    });
    this.commits.push({ from: current.status, to: transition.status });
    return true;
  }

  async heartbeat(
    _businessId: string,
    runId: string,
    owner: string,
    heartbeat: { expectedVersion: number; leaseExpiresAt: string }
  ): Promise<boolean> {
    const current = this.runs.get(runId);
    if (!current || current.leaseOwner !== owner || current.version !== heartbeat.expectedVersion) {
      return false;
    }
    this.runs.set(runId, { ...current, leaseExpiresAt: heartbeat.leaseExpiresAt });
    return true;
  }

  async reclaimExpiredRuns(
    _businessId: string,
    now: string,
    limit: number
  ): Promise<readonly PersistedRun[]> {
    const reclaimed: PersistedRun[] = [];
    for (const current of this.runs.values()) {
      if (reclaimed.length >= limit) break;
      const leased = current.status === "claimed" || current.status === "running";
      if (!leased || current.leaseExpiresAt === null || current.leaseExpiresAt > now) continue;
      const requeued: PersistedRun = {
        ...current,
        status: "queued",
        version: current.version + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      this.runs.set(current.id, requeued);
      this.commits.push({ from: current.status, to: "queued" });
      reclaimed.push(requeued);
    }
    return reclaimed;
  }

  async claimNextQueued(
    _businessId: string,
    owner: string,
    input: { now: string; leaseDurationMs: number; limit: number }
  ): Promise<readonly PersistedRun[]> {
    const claimed: PersistedRun[] = [];
    const leaseExpiresAt = new Date(
      new Date(input.now).getTime() + input.leaseDurationMs
    ).toISOString();
    for (const current of this.runs.values()) {
      if (claimed.length >= input.limit) break;
      if (current.status !== "queued") continue;
      const next: PersistedRun = {
        ...current,
        status: "claimed",
        version: current.version + 1,
        leaseOwner: owner,
        leaseExpiresAt,
      };
      this.runs.set(current.id, next);
      this.commits.push({ from: "queued", to: "claimed" });
      claimed.push(next);
    }
    return claimed;
  }

  async find(_businessId: string, runId: string): Promise<PersistedRun | null> {
    return this.runs.get(runId) ?? null;
  }
}

function dispatcher(
  store: DurableRunStore,
  owner: string,
  handler: (dispatched: PersistedRun) => Promise<RunOutcome>,
  now: () => Date = () => T0
): RunDispatcher {
  return new RunDispatcher({
    leases: new RunLeaseManager(store),
    businessId: BUSINESS_ID,
    owner,
    handler,
    now,
    leaseDurationMs: 60_000,
  });
}

describe("Run dispatch recovery", () => {
  it("parks a Run for reconciliation when the handler crashes mid-effect", async () => {
    const store = new DurableRunStore();
    store.seed();

    const result = await dispatcher(store, OWNER, async () => {
      throw new Error("effect ambiguous");
    }).dispatchBatch();

    expect(result).toEqual({ reclaimed: 0, claimed: 1, dispatched: 0, waiting: 0, failed: 1 });
    expect(await store.find(BUSINESS_ID, RUN_ID)).toMatchObject({
      status: "needs_reconciliation",
      leaseOwner: null,
    });
  });

  it("re-dispatches an accepted Run after the worker holding it died", async () => {
    const store = new DurableRunStore();
    // Worker 1 claimed and started the Run, then died without releasing its lease.
    store.seed({
      status: "running",
      version: 2,
      leaseOwner: OWNER,
      leaseExpiresAt: T0.toISOString(),
    });

    const handled: string[] = [];
    const recovered = await dispatcher(
      store,
      SURVIVOR,
      async (dispatched) => {
        handled.push(dispatched.id);
        return "succeeded";
      },
      () => AFTER_LEASE
    ).dispatchBatch();

    expect(recovered).toEqual({ reclaimed: 1, claimed: 1, dispatched: 1, waiting: 0, failed: 0 });
    expect(handled).toEqual([RUN_ID]);
    expect(await store.find(BUSINESS_ID, RUN_ID)).toMatchObject({
      status: "succeeded",
      leaseOwner: null,
    });
  });

  it("never runs a Run twice when a stale worker claims alongside the current one", async () => {
    const store = new DurableRunStore();
    store.seed();
    const handled: string[] = [];
    const handler = async (dispatched: PersistedRun): Promise<RunOutcome> => {
      handled.push(dispatched.leaseOwner ?? "");
      return "succeeded";
    };

    // Both workers claim the same batch; only the first `claimed`->`running` CAS can win.
    const stale = dispatcher(store, OWNER, handler);
    const current = dispatcher(store, SURVIVOR, handler);
    const [first, second] = [await stale.dispatchBatch(), await current.dispatchBatch()];

    expect(first).toEqual({ reclaimed: 0, claimed: 1, dispatched: 1, waiting: 0, failed: 0 });
    expect(second).toEqual({ reclaimed: 0, claimed: 0, dispatched: 0, waiting: 0, failed: 0 });
    expect(handled).toEqual([OWNER]);
    expect(store.commits.filter((commit) => commit.to === "succeeded")).toHaveLength(1);
  });

  it("leaves a Run untouched when its version moved after the batch claim", async () => {
    const store = new DurableRunStore();
    store.seed();
    const claimed = await store.claimNextQueued(BUSINESS_ID, OWNER, {
      now: T0.toISOString(),
      leaseDurationMs: 60_000,
      limit: 1,
    });
    expect(claimed).toHaveLength(1);

    // The Run is reclaimed out from under the batch before the worker starts it.
    const leases = new RunLeaseManager(store);
    await leases.reclaimExpired({ businessId: BUSINESS_ID, now: AFTER_LEASE, limit: 10 });

    const started = await leases.claim({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      owner: OWNER,
      now: AFTER_LEASE,
      leaseDurationMs: 60_000,
      expectedVersion: claimed[0].version,
      expectedStatus: "claimed",
      status: "running",
    });

    expect(started.claimed).toBe(false);
    expect(await store.find(BUSINESS_ID, RUN_ID)).toMatchObject({ status: "queued", version: 2 });
  });
});
