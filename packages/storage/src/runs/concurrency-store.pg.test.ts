import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  CONCURRENCY_STORAGE_STATEMENTS,
  ConcurrencyStore,
  type PersistedConcurrencySlot,
} from "./concurrency-store";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";

const BUSINESS = "business-1";
const TARGET_KEY = "sha256:target-1";
const CREATED_AT = "2026-07-25T10:00:00.000Z";
const RUN_A = "00000000-0000-4000-8000-00000000000a";
const RUN_B = "00000000-0000-4000-8000-00000000000b";
const RUN_C = "00000000-0000-4000-8000-00000000000c";

function run(id: string): StartRunInput {
  return {
    id,
    businessId: BUSINESS,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT,
    states: [{ key: "apply", definitionRef: "sha256:bundle-1#/states/apply", resolvedInput: {} }],
  };
}

function admit(
  store: ConcurrencyStore,
  runId: string,
  decide: Parameters<ConcurrencyStore["admit"]>[1]
) {
  return store.admit(
    {
      businessId: BUSINESS,
      runId,
      stateKey: "apply",
      targetKey: TARGET_KEY,
      policy: "serialize",
      requestedAt: CREATED_AT,
    },
    decide
  );
}

/** Mirrors the kernel's `serialize` decision: hold when idle, queue behind a live slot. */
const serialize = (slots: readonly PersistedConcurrencySlot[]) =>
  slots.some((entry) => entry.status === "held")
    ? ({ kind: "queue" } as const)
    : ({ kind: "hold" } as const);

describe("ConcurrencyStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: ConcurrencyStore;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [...RUN_STORAGE_STATEMENTS, ...CONCURRENCY_STORAGE_STATEMENTS]) {
      await database.exec(sql);
    }
    const transactions = transactionPort(database);
    store = new ConcurrencyStore(transactions);
    runs = new RunStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM run_concurrency_slots");
    await database.exec("DELETE FROM run_concurrency_keys");
    await database.exec("DELETE FROM state_attempts");
    await database.exec("DELETE FROM run_states");
    await database.exec("DELETE FROM run_lineage");
    await database.exec("DELETE FROM runs");
    for (const id of [RUN_A, RUN_B, RUN_C]) await runs.start(run(id));
  });

  it("holds the slot for the first admission on an idle target key", async () => {
    const result = await admit(store, RUN_A, serialize);

    expect(result.action).toEqual({ kind: "hold" });
    expect(await store.listSlots(BUSINESS, TARGET_KEY)).toEqual([
      { runId: RUN_A, status: "held", sequence: 1 },
    ]);
  });

  it("queues later admissions in first-come order", async () => {
    await admit(store, RUN_A, serialize);
    const second = await admit(store, RUN_B, serialize);
    const third = await admit(store, RUN_C, serialize);

    expect(second.action).toEqual({ kind: "queue" });
    expect(second.slots.map((entry) => entry.runId)).toEqual([RUN_A]);
    expect(third.slots.map((entry) => [entry.runId, entry.status])).toEqual([
      [RUN_A, "held"],
      [RUN_B, "queued"],
    ]);
  });

  it("promotes the earliest queued slot when the holder releases", async () => {
    await admit(store, RUN_A, serialize);
    await admit(store, RUN_B, serialize);
    await admit(store, RUN_C, serialize);

    const released = await store.release(BUSINESS, TARGET_KEY, RUN_A, CREATED_AT);

    expect(released).toEqual({ released: true, promotedRunId: RUN_B });
    const slots = await store.listSlots(BUSINESS, TARGET_KEY);
    expect(slots.map((entry) => [entry.runId, entry.status])).toEqual([
      [RUN_B, "held"],
      [RUN_C, "queued"],
    ]);
  });

  it("is idempotent: re-admitting a Run that already holds the key does not duplicate a slot", async () => {
    await admit(store, RUN_A, serialize);
    const again = await admit(store, RUN_A, serialize);

    expect(again.action).toEqual({ kind: "hold" });
    expect(await store.listSlots(BUSINESS, TARGET_KEY)).toHaveLength(1);
  });

  it("records superseded slots instead of deleting them so cancellation stays observable", async () => {
    await admit(store, RUN_A, serialize);

    const result = await store.admit(
      {
        businessId: BUSINESS,
        runId: RUN_B,
        stateKey: "apply",
        targetKey: TARGET_KEY,
        policy: "supersede",
        requestedAt: CREATED_AT,
      },
      () => ({ kind: "supersede", supersedeRunIds: [RUN_A] })
    );

    expect(result.action.kind).toBe("supersede");
    const slots = await store.listSlots(BUSINESS, TARGET_KEY);
    expect(slots.find((entry) => entry.runId === RUN_A)?.status).toBe("superseded");
    expect(slots.find((entry) => entry.runId === RUN_B)?.status).toBe("held");
  });

  it("does not admit a rejected request", async () => {
    await admit(store, RUN_A, serialize);

    const rejected = await store.admit(
      {
        businessId: BUSINESS,
        runId: RUN_B,
        stateKey: "apply",
        targetKey: TARGET_KEY,
        policy: "reject",
        requestedAt: CREATED_AT,
      },
      () => ({ kind: "reject", reason: "target_busy" })
    );

    expect(rejected.action).toEqual({ kind: "reject", reason: "target_busy" });
    expect(await store.listSlots(BUSINESS, TARGET_KEY)).toHaveLength(1);
  });

  it("releases a slot that no longer exists without promoting anything", async () => {
    expect(await store.release(BUSINESS, TARGET_KEY, RUN_A, CREATED_AT)).toEqual({
      released: false,
      promotedRunId: null,
    });
  });

  it("scopes slots by business so one business never blocks another", async () => {
    await admit(store, RUN_A, serialize);

    expect(await store.listSlots("business-2", TARGET_KEY)).toEqual([]);
  });
});
