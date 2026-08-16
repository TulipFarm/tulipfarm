import { describe, expect, it } from "vitest";
import {
  type AcquireStateConcurrencyInput,
  acquireStateConcurrencyKey,
  InMemoryStateConcurrencyStore,
  STATE_CONCURRENCY_ATTEMPTS,
  STATE_CONCURRENCY_LEASE_MS,
  STATE_CONCURRENCY_POLL_MS,
  type StateConcurrencyAcquisition,
  type StateConcurrencyStore,
  stateConcurrencyExpiry,
} from "./concurrency-lease";

const BUSINESS = "business-1";
const KEY = "invoice-sync";
const RUN = "run-1";
const OTHER_RUN = "run-2";
const NOW = "2026-07-25T10:00:00.000Z";
const EXPIRES = "2026-07-25T10:01:00.000Z";
const AFTER_EXPIRY = "2026-07-25T10:02:00.000Z";

function input(overrides: Partial<AcquireStateConcurrencyInput> = {}) {
  return {
    businessId: BUSINESS,
    concurrencyKey: KEY,
    runId: RUN,
    stateKey: "Notify",
    now: NOW,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

describe("InMemoryStateConcurrencyStore", () => {
  it("grants a free key and refuses a live contender", async () => {
    const store = new InMemoryStateConcurrencyStore();
    expect(await store.acquire(input())).toEqual({ kind: "acquired" });
    expect(await store.acquire(input({ runId: OTHER_RUN }))).toEqual({
      kind: "busy",
      heldByRunId: RUN,
    });
  });

  it("treats another State of the holding Run as reentrant", async () => {
    const store = new InMemoryStateConcurrencyStore();
    await store.acquire(input({ stateKey: "Outer" }));
    expect(await store.acquire(input({ stateKey: "Outer/0/Inner" }))).toEqual({
      kind: "reentrant",
    });
  });

  it("lets a contender take over once the holder's lease expires", async () => {
    const store = new InMemoryStateConcurrencyStore();
    await store.acquire(input());
    expect(
      await store.acquire(input({ runId: OTHER_RUN, now: AFTER_EXPIRY, expiresAt: AFTER_EXPIRY }))
    ).toEqual({ kind: "acquired" });
  });

  it("releases only for the exact holder", async () => {
    const store = new InMemoryStateConcurrencyStore();
    await store.acquire(input());
    expect(await store.release(BUSINESS, KEY, OTHER_RUN, "Notify")).toBe(false);
    expect(await store.release(BUSINESS, KEY, RUN, "Other")).toBe(false);
    expect(await store.release(BUSINESS, KEY, RUN, "Notify")).toBe(true);
  });
});

describe("stateConcurrencyExpiry", () => {
  const now = new Date(NOW);

  it("uses the default lease term when the Run declares none", () => {
    expect(stateConcurrencyExpiry(now, null)).toBe(
      new Date(now.getTime() + STATE_CONCURRENCY_LEASE_MS).toISOString()
    );
  });

  it("never expires before the holder Run's own lease does", () => {
    const runLease = new Date(now.getTime() + 10 * STATE_CONCURRENCY_LEASE_MS).toISOString();
    expect(stateConcurrencyExpiry(now, runLease)).toBe(runLease);
  });

  it("ignores a Run lease that already expired", () => {
    expect(stateConcurrencyExpiry(now, "2020-01-01T00:00:00.000Z")).toBe(
      new Date(now.getTime() + STATE_CONCURRENCY_LEASE_MS).toISOString()
    );
  });
});

describe("acquireStateConcurrencyKey", () => {
  class ScriptedStore implements StateConcurrencyStore {
    calls = 0;
    constructor(private readonly script: readonly StateConcurrencyAcquisition[]) {}

    async acquire(): Promise<StateConcurrencyAcquisition> {
      const result = this.script[this.calls] ?? this.script[this.script.length - 1];
      this.calls += 1;
      return result ?? { kind: "busy", heldByRunId: OTHER_RUN };
    }

    async release(): Promise<boolean> {
      return true;
    }
  }

  function args(store: StateConcurrencyStore, delays: number[]) {
    return {
      store,
      businessId: BUSINESS,
      concurrencyKey: KEY,
      runId: RUN,
      stateKey: "Notify",
      runLeaseExpiresAt: null,
      now: () => new Date(NOW),
      delay: async (ms: number) => {
        delays.push(ms);
      },
    };
  }

  it("takes a free key without waiting", async () => {
    const delays: number[] = [];
    const store = new ScriptedStore([{ kind: "acquired" }]);
    expect(await acquireStateConcurrencyKey(args(store, delays))).toBe("acquired");
    expect(delays).toEqual([]);
  });

  it("waits out a contender that frees the key mid-poll", async () => {
    const delays: number[] = [];
    const store = new ScriptedStore([
      { kind: "busy", heldByRunId: OTHER_RUN },
      { kind: "busy", heldByRunId: OTHER_RUN },
      { kind: "acquired" },
    ]);
    expect(await acquireStateConcurrencyKey(args(store, delays))).toBe("acquired");
    expect(delays).toEqual([STATE_CONCURRENCY_POLL_MS, STATE_CONCURRENCY_POLL_MS]);
  });

  it("gives up after the bounded wait rather than spinning on a frozen clock", async () => {
    const delays: number[] = [];
    const store = new ScriptedStore([{ kind: "busy", heldByRunId: OTHER_RUN }]);
    expect(await acquireStateConcurrencyKey(args(store, delays))).toBe("busy");
    expect(store.calls).toBe(STATE_CONCURRENCY_ATTEMPTS);
    expect(delays).toHaveLength(STATE_CONCURRENCY_ATTEMPTS - 1);
  });

  it("reports reentrancy without waiting, so a nested State cannot self-deadlock", async () => {
    const delays: number[] = [];
    const store = new ScriptedStore([{ kind: "reentrant" }]);
    expect(await acquireStateConcurrencyKey(args(store, delays))).toBe("reentrant");
    expect(delays).toEqual([]);
  });
});
