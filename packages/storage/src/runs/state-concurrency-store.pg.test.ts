import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";
import {
  RunStateConcurrencyStore,
  STATE_CONCURRENCY_STORAGE_STATEMENTS,
} from "./state-concurrency-store";

const BUSINESS = "business-1";
const OTHER_BUSINESS = "business-2";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_BUSINESS_RUN_ID = "00000000-0000-4000-8000-000000000003";
const CREATED_AT = "2026-07-25T10:00:00.000Z";
const NOW = "2026-07-25T10:00:00.000Z";
const EXPIRES = "2026-07-25T10:01:00.000Z";
const AFTER_EXPIRY = "2026-07-25T10:02:00.000Z";
const KEY = "invoice-sync";

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
    createdAt: CREATED_AT,
    states: [{ key: "Notify", definitionRef: "sha256:bundle-1#/states/Notify", resolvedInput: {} }],
  };
}

describe("RunStateConcurrencyStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: RunStateConcurrencyStore;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [...RUN_STORAGE_STATEMENTS, ...STATE_CONCURRENCY_STORAGE_STATEMENTS]) {
      await database.exec(sql);
    }
    const transactions = transactionPort(database);
    store = new RunStateConcurrencyStore(transactions);
    runs = new RunStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM state_concurrency_leases");
    await database.exec("DELETE FROM state_attempts");
    await database.exec("DELETE FROM run_states");
    await database.exec("DELETE FROM run_lineage");
    await database.exec("DELETE FROM runs");
    await runs.start(run(RUN_ID, BUSINESS));
    await runs.start(run(OTHER_RUN_ID, BUSINESS));
    await runs.start(run(OTHER_BUSINESS_RUN_ID, OTHER_BUSINESS));
  });

  function acquire(
    runId: string,
    stateKey: string,
    now = NOW,
    expiresAt = EXPIRES,
    businessId = BUSINESS
  ) {
    return store.acquire({ businessId, concurrencyKey: KEY, runId, stateKey, now, expiresAt });
  }

  it("grants a free key", async () => {
    expect(await acquire(RUN_ID, "Notify")).toEqual({ kind: "acquired" });
  });

  it("refuses a second Run while the holder's lease is live", async () => {
    await acquire(RUN_ID, "Notify");
    expect(await acquire(OTHER_RUN_ID, "Notify")).toEqual({
      kind: "busy",
      heldByRunId: RUN_ID,
    });
  });

  it("reports a second State of the holding Run as reentrant, never busy", async () => {
    await acquire(RUN_ID, "Outer");
    // Blocking here would be a self-deadlock: the only holder is this Run's own outer State.
    expect(await acquire(RUN_ID, "Outer/0/Inner")).toEqual({ kind: "reentrant" });
  });

  it("lets the same State occurrence re-take and extend its own lease", async () => {
    await acquire(RUN_ID, "Notify");
    expect(await acquire(RUN_ID, "Notify", NOW, AFTER_EXPIRY)).toEqual({ kind: "acquired" });
    expect((await store.find(BUSINESS, KEY))?.expiresAt).toBe(AFTER_EXPIRY);
  });

  it("lets a contender take a key whose holder crashed and let the lease expire", async () => {
    await acquire(RUN_ID, "Notify");
    expect(await acquire(OTHER_RUN_ID, "Notify", AFTER_EXPIRY, AFTER_EXPIRY)).toEqual({
      kind: "acquired",
    });
    expect((await store.find(BUSINESS, KEY))?.runId).toBe(OTHER_RUN_ID);
  });

  it("scopes a key to its business", async () => {
    await acquire(RUN_ID, "Notify");
    expect(await acquire(OTHER_BUSINESS_RUN_ID, "Notify", NOW, EXPIRES, OTHER_BUSINESS)).toEqual({
      kind: "acquired",
    });
  });

  it("frees the key on release and lets the next contender in", async () => {
    await acquire(RUN_ID, "Notify");
    expect(await store.release(BUSINESS, KEY, RUN_ID, "Notify")).toBe(true);
    expect(await store.find(BUSINESS, KEY)).toBeUndefined();
    expect(await acquire(OTHER_RUN_ID, "Notify")).toEqual({ kind: "acquired" });
  });

  it("refuses to release a lease another holder has already taken over", async () => {
    await acquire(RUN_ID, "Notify");
    await acquire(OTHER_RUN_ID, "Notify", AFTER_EXPIRY, AFTER_EXPIRY);
    // The crashed holder waking up late must not free the key out from under its successor.
    expect(await store.release(BUSINESS, KEY, RUN_ID, "Notify")).toBe(false);
    expect((await store.find(BUSINESS, KEY))?.runId).toBe(OTHER_RUN_ID);
  });
});
