import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { type AppendRunEventInput, RUN_EVENT_STORAGE_STATEMENTS, RunEventStore } from "./events";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";

const BUSINESS = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "00000000-0000-4000-8000-000000000002";
const OCCURRED_AT = "2026-07-25T10:00:00.000Z";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

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
    createdAt: OCCURRED_AT,
    states: [{ key: "apply", definitionRef: "sha256:bundle-1#/states/apply", resolvedInput: {} }],
  };
}

describe("RunEventStore", () => {
  let database: PGlite;
  let store: RunEventStore;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [...RUN_STORAGE_STATEMENTS, ...RUN_EVENT_STORAGE_STATEMENTS]) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    store = new RunEventStore(transactions);
    runs = new RunStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE runs CASCADE");
    for (const id of [RUN_ID, OTHER_RUN_ID]) {
      await runs.start(run(id));
    }
  });

  function event(overrides: Partial<AppendRunEventInput> = {}): AppendRunEventInput {
    return {
      businessId: BUSINESS,
      runId: RUN_ID,
      eventType: "state.transitioned",
      audience: "participant",
      payload: { stateKey: "apply", status: "running" },
      idempotencyKey: "attempt-1:running",
      occurredAt: OCCURRED_AT,
      ...overrides,
    };
  }

  it("assigns a gapless monotonic sequence per Run", async () => {
    const first = await store.append(event());
    const second = await store.append(event({ idempotencyKey: "attempt-1:succeeded" }));
    const otherRun = await store.append(event({ runId: OTHER_RUN_ID }));

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(otherRun.sequence).toBe(1);
  });

  it("collapses a duplicate delivery onto the event it already recorded", async () => {
    const first = await store.append(event());

    const replay = await store.append(event({ payload: { tampered: true } }));

    expect(replay).toEqual(first);
    expect(
      await store.list(BUSINESS, RUN_ID, { after: 0, audiences: ["participant"] })
    ).toHaveLength(1);
  });

  it("lists only events after the cursor, in sequence order", async () => {
    await store.append(event({ idempotencyKey: "a" }));
    await store.append(event({ idempotencyKey: "b" }));
    await store.append(event({ idempotencyKey: "c" }));

    const page = await store.list(BUSINESS, RUN_ID, { after: 1, audiences: ["participant"] });

    expect(page.map((entry) => entry.sequence)).toEqual([2, 3]);
  });

  it("bounds a page so a reconnecting client cannot pull an unbounded backlog", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.append(event({ idempotencyKey: `k-${index}` }));
    }

    const page = await store.list(BUSINESS, RUN_ID, {
      after: 0,
      audiences: ["participant"],
      limit: 2,
    });

    expect(page.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it("withholds events the reader's audience does not cover", async () => {
    await store.append(event({ audience: "participant", idempotencyKey: "p" }));
    await store.append(event({ audience: "operator", idempotencyKey: "o" }));

    const asParticipant = await store.list(BUSINESS, RUN_ID, {
      after: 0,
      audiences: ["participant"],
    });
    const asOperator = await store.list(BUSINESS, RUN_ID, {
      after: 0,
      audiences: ["participant", "operator"],
    });

    expect(asParticipant.map((entry) => entry.audience)).toEqual(["participant"]);
    expect(asOperator).toHaveLength(2);
  });

  it("returns nothing when the reader has no audience, so access is default-deny", async () => {
    await store.append(event());

    expect(await store.list(BUSINESS, RUN_ID, { after: 0, audiences: [] })).toEqual([]);
  });

  it("never returns another business's events for the same Run id", async () => {
    await store.append(event());

    expect(
      await store.list("business-2", RUN_ID, { after: 0, audiences: ["participant"] })
    ).toEqual([]);
  });

  it("reports the latest sequence so a reader can detect a gap", async () => {
    await store.append(event({ idempotencyKey: "a" }));
    await store.append(event({ idempotencyKey: "b" }));

    expect(await store.latestSequence(BUSINESS, RUN_ID)).toBe(2);
    expect(await store.latestSequence(BUSINESS, OTHER_RUN_ID)).toBe(0);
  });

  it("keeps the stream append-only so a delivered event cannot be rewritten", async () => {
    await store.append(event());

    await expect(database.exec("UPDATE run_events SET payload = '{}'::jsonb")).rejects.toThrow(
      /run_event_append_only/
    );
    await expect(database.exec("DELETE FROM run_events WHERE sequence = 1")).rejects.toThrow(
      /run_event_append_only/
    );
  });
});
