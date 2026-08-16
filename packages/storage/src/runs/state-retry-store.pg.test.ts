import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";
import { RunStateRetryStore, STATE_RETRY_STORAGE_STATEMENTS } from "./state-retry-store";

const BUSINESS = "business-1";
const OTHER_BUSINESS = "business-2";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "00000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-07-25T10:00:00.000Z";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function run(id: string, businessId: string): StartRunInput {
  return {
    id,
    businessId,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    bounds: { wallTimeMs: 60_000, activeTimeMs: 30_000, attempts: 3, sideEffects: 2 },
    createdAt: CREATED_AT,
    states: [{ key: "Notify", definitionRef: "sha256:bundle-1#/states/Notify", resolvedInput: {} }],
  };
}

describe("RunStateRetryStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: RunStateRetryStore;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [...RUN_STORAGE_STATEMENTS, ...STATE_RETRY_STORAGE_STATEMENTS]) {
      await database.exec(sql);
    }
    const transactions = transactionPort(database);
    store = new RunStateRetryStore(transactions);
    runs = new RunStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM state_retry_attempts");
    await database.exec("DELETE FROM state_attempts");
    await database.exec("DELETE FROM run_states");
    await database.exec("DELETE FROM run_lineage");
    await database.exec("DELETE FROM runs");
    await runs.start(run(RUN_ID, BUSINESS));
    await runs.start(run(OTHER_RUN_ID, BUSINESS));
  });

  it("returns nothing before the first record", async () => {
    expect(await store.load(BUSINESS, RUN_ID, "Notify")).toBeUndefined();
  });

  it("persists and reloads the spent attempt count for a State occurrence", async () => {
    await store.record({ businessId: BUSINESS, runId: RUN_ID, stateKey: "Notify", attempts: 2 });
    expect(await store.load(BUSINESS, RUN_ID, "Notify")).toEqual({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateKey: "Notify",
      attempts: 2,
    });
  });

  it("advances monotonically and never lets a stale writer lower the count", async () => {
    await store.record({ businessId: BUSINESS, runId: RUN_ID, stateKey: "Notify", attempts: 3 });
    // A racing or replayed pass carrying a lower total must not refund the budget.
    await store.record({ businessId: BUSINESS, runId: RUN_ID, stateKey: "Notify", attempts: 1 });
    expect((await store.load(BUSINESS, RUN_ID, "Notify"))?.attempts).toBe(3);
  });

  it("keeps counts separate per State occurrence, Run, and business", async () => {
    await store.record({ businessId: BUSINESS, runId: RUN_ID, stateKey: "Notify", attempts: 2 });
    await store.record({ businessId: BUSINESS, runId: RUN_ID, stateKey: "Other", attempts: 5 });
    await store.record({
      businessId: BUSINESS,
      runId: OTHER_RUN_ID,
      stateKey: "Notify",
      attempts: 9,
    });
    expect((await store.load(BUSINESS, RUN_ID, "Notify"))?.attempts).toBe(2);
    expect((await store.load(BUSINESS, RUN_ID, "Other"))?.attempts).toBe(5);
    expect((await store.load(BUSINESS, OTHER_RUN_ID, "Notify"))?.attempts).toBe(9);
    expect(await store.load(OTHER_BUSINESS, RUN_ID, "Notify")).toBeUndefined();
  });

  it("refuses a counter for a Run that does not exist", async () => {
    await expect(
      store.record({
        businessId: BUSINESS,
        runId: "00000000-0000-4000-8000-0000000000ff",
        stateKey: "Notify",
        attempts: 1,
      })
    ).rejects.toThrow();
  });
});
