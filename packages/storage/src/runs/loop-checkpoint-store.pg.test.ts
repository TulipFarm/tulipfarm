import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import {
  LOOP_CHECKPOINT_STORAGE_STATEMENTS,
  RunLoopCheckpointStore,
} from "./loop-checkpoint-store";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";

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
    source: "chat",
    bundle: { digest: "sha256:bundle-1", routineId: "chat", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT,
    states: [{ key: "invoke", definitionRef: "sha256:bundle-1#/states/invoke", resolvedInput: {} }],
  };
}

describe("RunLoopCheckpointStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: RunLoopCheckpointStore;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [...RUN_STORAGE_STATEMENTS, ...LOOP_CHECKPOINT_STORAGE_STATEMENTS]) {
      await database.exec(sql);
    }
    const transactions = transactionPort(database);
    store = new RunLoopCheckpointStore(transactions);
    runs = new RunStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM agent_loop_checkpoints");
    await database.exec("DELETE FROM state_attempts");
    await database.exec("DELETE FROM run_states");
    await database.exec("DELETE FROM run_lineage");
    await database.exec("DELETE FROM runs");
    await runs.start(run(RUN_ID, BUSINESS));
    await runs.start(run(OTHER_RUN_ID, BUSINESS));
  });

  it("returns nothing before the first save", async () => {
    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toBeUndefined();
  });

  it("round-trips the counters it persisted", async () => {
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 3,
      toolCalls: 7,
      repairs: 1,
    });

    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toEqual({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 3,
      toolCalls: 7,
      repairs: 1,
    });
  });

  it("upserts the same key in place rather than duplicating it", async () => {
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 1,
      toolCalls: 1,
      repairs: 0,
    });
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 2,
      toolCalls: 4,
      repairs: 2,
    });

    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
      iterations: 2,
      toolCalls: 4,
      repairs: 2,
    });
    const count = await database.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM agent_loop_checkpoints"
    );
    expect(count.rows[0]?.n).toBe("1");
  });

  it("never lets a counter move backwards, so a stale writer cannot buy back a spent ceiling", async () => {
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 5,
      toolCalls: 9,
      repairs: 2,
    });
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 1,
      toolCalls: 0,
      repairs: 0,
    });

    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
      iterations: 5,
      toolCalls: 9,
      repairs: 2,
    });
  });

  it("keeps checkpoints for different States of the same Run apart", async () => {
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 1,
      toolCalls: 2,
      repairs: 0,
    });

    expect(await store.load(BUSINESS, RUN_ID, "other-state")).toBeUndefined();
  });

  it("keeps checkpoints for different Runs apart", async () => {
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 4,
      toolCalls: 6,
      repairs: 1,
    });

    expect(await store.load(BUSINESS, OTHER_RUN_ID, "invoke")).toBeUndefined();
  });

  it("scopes reads to the business, refusing a checkpoint under the wrong tenant", async () => {
    await store.save({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 2,
      toolCalls: 3,
      repairs: 0,
    });

    expect(await store.load(OTHER_BUSINESS, RUN_ID, "invoke")).toBeUndefined();
    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({ toolCalls: 3 });
  });
});
