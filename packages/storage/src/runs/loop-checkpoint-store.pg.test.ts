import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  LOOP_CHECKPOINT_STORAGE_STATEMENTS,
  RunLoopCheckpointStore,
  StaleLoopCheckpointWriterError,
} from "./loop-checkpoint-store";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";

const BUSINESS = "business-1";
const OTHER_BUSINESS = "business-2";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "00000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-07-25T10:00:00.000Z";

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
  let leaseGeneration: number;

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
    await runs.transitionRun(BUSINESS, RUN_ID, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "running",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-25T10:01:00.000Z",
    });
    leaseGeneration = (await runs.find(BUSINESS, RUN_ID))?.leaseGeneration ?? -1;
  });

  it("returns nothing before the first save", async () => {
    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toBeUndefined();
  });

  it("round-trips the counters it persisted", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 3,
        toolCalls: 7,
        repairs: 1,
      },
      { leaseGeneration }
    );

    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toEqual({
      businessId: BUSINESS,
      runId: RUN_ID,
      stateId: "invoke",
      iterations: 3,
      toolCalls: 7,
      repairs: 1,
    });
  });

  it("round-trips an unfinished Tool batch for process reconstruction", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 1,
        toolCalls: 1,
        repairs: 0,
        resume: {
          messages: [],
          pendingBatch: {
            calls: [
              { callId: "write-1", name: "kv_set", arguments: { key: "a" } },
              { callId: "write-2", name: "kv_set", arguments: { key: "b" } },
            ],
            nextCallIndex: 1,
          },
          sequence: 4,
          textIndex: 0,
        },
      },
      { leaseGeneration }
    );

    const reconstructed = new RunLoopCheckpointStore(transactionPort(database));

    expect(await reconstructed.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
      toolCalls: 1,
      resume: {
        pendingBatch: {
          calls: [{ callId: "write-1" }, { callId: "write-2" }],
          nextCallIndex: 1,
        },
        sequence: 4,
      },
    });
  });

  it("round-trips a terminal result and its immutable event for process reconstruction", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 2,
        toolCalls: 1,
        repairs: 0,
        resume: {
          messages: [],
          sequence: 5,
          textIndex: 1,
          terminal: {
            outcome: {
              status: "completed",
              output: "done",
              iterations: 2,
              toolCalls: 1,
              repairs: 0,
            },
            event: {
              sequence: 5,
              businessId: BUSINESS,
              runId: RUN_ID,
              stateId: "invoke",
              type: "completed",
              iteration: 2,
              occurredAt: "2026-07-25T10:00:30.000Z",
            },
          },
        },
      },
      { leaseGeneration }
    );

    const reconstructed = new RunLoopCheckpointStore(transactionPort(database));
    expect(await reconstructed.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
      resume: {
        sequence: 5,
        terminal: {
          outcome: { status: "completed", output: "done" },
          event: { sequence: 5, type: "completed" },
        },
      },
    });
  });

  it("upserts the same key in place rather than duplicating it", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 1,
        toolCalls: 1,
        repairs: 0,
      },
      { leaseGeneration }
    );
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 2,
        toolCalls: 4,
        repairs: 2,
      },
      { leaseGeneration }
    );

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
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 5,
        toolCalls: 9,
        repairs: 2,
      },
      { leaseGeneration }
    );
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 1,
        toolCalls: 0,
        repairs: 0,
      },
      { leaseGeneration }
    );

    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
      iterations: 5,
      toolCalls: 9,
      repairs: 2,
    });
  });

  it("keeps checkpoints for different States of the same Run apart", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 1,
        toolCalls: 2,
        repairs: 0,
      },
      { leaseGeneration }
    );

    expect(await store.load(BUSINESS, RUN_ID, "other-state")).toBeUndefined();
  });

  it("keeps checkpoints for different Runs apart", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 4,
        toolCalls: 6,
        repairs: 1,
      },
      { leaseGeneration }
    );

    expect(await store.load(BUSINESS, OTHER_RUN_ID, "invoke")).toBeUndefined();
  });

  it("scopes reads to the business, refusing a checkpoint under the wrong tenant", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 2,
        toolCalls: 3,
        repairs: 0,
      },
      { leaseGeneration }
    );

    expect(await store.load(OTHER_BUSINESS, RUN_ID, "invoke")).toBeUndefined();
    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({ toolCalls: 3 });
  });

  it.each(["worker-2", "worker-1"])(
    "rejects a late checkpoint after the Run is reclaimed by %s",
    async (nextOwner) => {
      await store.save(
        {
          businessId: BUSINESS,
          runId: RUN_ID,
          stateId: "invoke",
          iterations: 2,
          toolCalls: 3,
          repairs: 0,
          resume: { messages: [], sequence: 2, textIndex: 0 },
        },
        { leaseGeneration }
      );
      await runs.transitionRun(BUSINESS, RUN_ID, {
        expectedVersion: 1,
        expectedStatus: "running",
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      await runs.transitionRun(BUSINESS, RUN_ID, {
        expectedVersion: 2,
        expectedStatus: "queued",
        status: "running",
        leaseOwner: nextOwner,
        leaseExpiresAt: "2026-07-25T10:02:00.000Z",
      });

      await expect(
        store.save(
          {
            businessId: BUSINESS,
            runId: RUN_ID,
            stateId: "invoke",
            iterations: 9,
            toolCalls: 9,
            repairs: 0,
            resume: { messages: [], sequence: 9, textIndex: 0 },
          },
          { leaseGeneration }
        )
      ).rejects.toBeInstanceOf(StaleLoopCheckpointWriterError);
      expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
        iterations: 2,
        toolCalls: 3,
        resume: { sequence: 2 },
      });
    }
  );

  it("keeps the claim generation stable across heartbeats", async () => {
    await runs.heartbeat(BUSINESS, RUN_ID, "worker-1", {
      expectedVersion: 1,
      leaseExpiresAt: "2026-07-25T10:02:00.000Z",
    });

    expect((await runs.find(BUSINESS, RUN_ID))?.leaseGeneration).toBe(leaseGeneration);
    await expect(
      store.save(
        {
          businessId: BUSINESS,
          runId: RUN_ID,
          stateId: "invoke",
          iterations: 1,
          toolCalls: 0,
          repairs: 0,
        },
        { leaseGeneration }
      )
    ).resolves.toBeUndefined();
  });

  it("rejects a late checkpoint after the same claim has settled", async () => {
    await runs.transitionRun(BUSINESS, RUN_ID, {
      expectedVersion: 1,
      expectedStatus: "running",
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    await expect(
      store.save(
        {
          businessId: BUSINESS,
          runId: RUN_ID,
          stateId: "invoke",
          iterations: 1,
          toolCalls: 0,
          repairs: 0,
        },
        { leaseGeneration }
      )
    ).rejects.toBeInstanceOf(StaleLoopCheckpointWriterError);
  });

  it("clears terminal checkpoints only for the current Run claim", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 1,
        toolCalls: 0,
        repairs: 0,
      },
      { leaseGeneration }
    );
    await runs.transitionRun(BUSINESS, RUN_ID, {
      expectedVersion: 1,
      expectedStatus: "running",
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await runs.transitionRun(BUSINESS, RUN_ID, {
      expectedVersion: 2,
      expectedStatus: "queued",
      status: "running",
      leaseOwner: "worker-2",
      leaseExpiresAt: "2026-07-25T10:02:00.000Z",
    });
    const currentGeneration = (await runs.find(BUSINESS, RUN_ID))?.leaseGeneration ?? -1;

    await expect(
      store.clear(BUSINESS, RUN_ID, undefined, { leaseGeneration })
    ).rejects.toBeInstanceOf(StaleLoopCheckpointWriterError);
    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toBeDefined();

    await store.clear(BUSINESS, RUN_ID, undefined, { leaseGeneration: currentGeneration });
    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toBeUndefined();
  });

  it("retires terminal delivery while retaining retryable transcript", async () => {
    await store.save(
      {
        businessId: BUSINESS,
        runId: RUN_ID,
        stateId: "invoke",
        iterations: 2,
        toolCalls: 1,
        repairs: 0,
        resume: {
          messages: [{ role: "tool", content: [{ type: "text", text: "stored result" }] }],
          retryable: true,
          sequence: 4,
          textIndex: 0,
          terminal: {
            outcome: {
              status: "failed",
              reason: "model_provider_unavailable",
              iterations: 2,
              toolCalls: 1,
              repairs: 0,
            },
            event: {
              sequence: 4,
              businessId: BUSINESS,
              runId: RUN_ID,
              stateId: "invoke",
              type: "failed",
              iteration: 2,
              occurredAt: "2026-07-25T10:00:03.000Z",
            },
          },
        },
      },
      { leaseGeneration }
    );

    await store.acknowledgeTerminal(BUSINESS, RUN_ID, "invoke", { leaseGeneration });
    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
      resume: {
        retryable: true,
        retryAttempt: 1,
        messages: [{ role: "tool", content: [{ type: "text", text: "stored result" }] }],
      },
    });
    expect((await store.load(BUSINESS, RUN_ID, "invoke"))?.resume?.terminal).toBeUndefined();
    await store.acknowledgeTerminal(BUSINESS, RUN_ID, "invoke", { leaseGeneration });
    expect((await store.load(BUSINESS, RUN_ID, "invoke"))?.resume?.retryAttempt).toBe(1);

    await runs.transitionRun(BUSINESS, RUN_ID, {
      expectedVersion: 1,
      expectedStatus: "running",
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    await store.settle(BUSINESS, RUN_ID, undefined, { leaseGeneration });

    expect(await store.load(BUSINESS, RUN_ID, "invoke")).toMatchObject({
      iterations: 2,
      toolCalls: 1,
      resume: {
        retryable: true,
        retryAttempt: 1,
        messages: [{ role: "tool", content: [{ type: "text", text: "stored result" }] }],
        sequence: 4,
      },
    });
    expect((await store.load(BUSINESS, RUN_ID, "invoke"))?.resume?.terminal).toBeUndefined();
  });
});
