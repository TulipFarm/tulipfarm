import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { RoutineDefinition } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { RoutineRunsRepo } from "./run-store-adapter";

const DEF = {
  id: "r",
  version: "1.0",
  start: "Start",
  "x-triggers": [{ type: "manual" }],
  states: [{ name: "Start", type: "inject", data: {}, end: true }],
} as unknown as RoutineDefinition;

type PendingRunEvent = { type: string; payload: Record<string, unknown> };
type TransitionResult = {
  transitioned: boolean;
  events: Array<{ runId: string; seq: number; type: string; payload: unknown; createdAt: Date }>;
};
type AtomicRoutineRunsRepo = RoutineRunsRepo & {
  appendEvents(runId: string, events: PendingRunEvent[]): Promise<TransitionResult["events"]>;
  transitionWithEvents(
    id: string,
    expected: { status: "pending" | "running"; currentState?: string | null },
    patch: { status?: "running" | "succeeded"; currentState?: string | null },
    events: PendingRunEvent[]
  ): Promise<TransitionResult>;
};

function atomic(repo: RoutineRunsRepo): AtomicRoutineRunsRepo {
  return repo as AtomicRoutineRunsRepo;
}

function collisionError(): Error & { code: string } {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
}

class CollisionQueryable implements Queryable {
  attempts = 0;

  constructor(
    private readonly delegate: Queryable,
    private readonly collisions: number
  ) {}

  async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (/routine_run_events/i.test(text) && /insert/i.test(text)) {
      this.attempts += 1;
      if (this.attempts <= this.collisions) throw collisionError();
    }
    return this.delegate.query(text, params);
  }
}

describe("RoutineRunsRepo (PGlite)", () => {
  let db: PGlite;
  let repo: RoutineRunsRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new RoutineRunsRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function createRun(id = randomUUID()) {
    await repo.create({
      id,
      routineSlug: "daily-report",
      definitionSnapshot: DEF,
      definitionHash: "abc123",
      currentState: "Start",
      context: { seeded: true },
      trigger: { type: "manual", payload: { a: 1 } },
    });
    return id;
  }

  it("creates a pending run with a pinned definition snapshot", async () => {
    const id = await createRun();
    const run = await repo.findById(id);
    expect(run?.status).toBe("pending");
    expect(run?.currentState).toBe("Start");
    expect(run?.definitionSnapshot.id).toBe("r");
    expect(run?.definitionHash).toBe("abc123");
    expect(run?.context).toEqual({ seeded: true });
    expect(run?.trigger).toEqual({ type: "manual", payload: { a: 1 } });
  });

  it("keeps the snapshot when listing by slug", async () => {
    await createRun();
    await createRun();
    const runs = await repo.listBySlug("daily-report");
    expect(runs).toHaveLength(2);
    expect(runs[0].definitionSnapshot.states).toHaveLength(1);
  });

  it("CAS transition succeeds only when status+state match", async () => {
    const id = await createRun();

    const ok = await repo.transition(
      id,
      { status: "pending" },
      { status: "running", currentState: "Start" }
    );
    expect(ok).toBe(true);

    // stale expectation: still thinks it's pending
    const stale = await repo.transition(id, { status: "pending" }, { status: "running" });
    expect(stale).toBe(false);

    // state guard
    const wrongState = await repo.transition(
      id,
      { status: "running", currentState: "Other" },
      { currentState: "Next" }
    );
    expect(wrongState).toBe(false);

    const rightState = await repo.transition(
      id,
      { status: "running", currentState: "Start" },
      { currentState: "Next", context: { moved: true } }
    );
    expect(rightState).toBe(true);
    const run = await repo.findById(id);
    expect(run?.currentState).toBe("Next");
    expect(run?.context).toEqual({ moved: true });
  });

  it("supports wake/deadline bookkeeping and overdue listing", async () => {
    const id = await createRun();
    const past = new Date(Date.now() - 60_000);
    await repo.transition(id, { status: "pending" }, { status: "sleeping", wakeAt: past });

    const overdue = await repo.listOverdueWakes(new Date());
    expect(overdue.map((r) => r.id)).toContain(id);

    await repo.transition(id, { status: "sleeping" }, { status: "running", wakeAt: null });
    expect(await repo.listOverdueWakes(new Date())).toHaveLength(0);
  });

  it("lists expired state deadlines only for running runs", async () => {
    const id = await createRun();
    const past = new Date(Date.now() - 1_000);
    await repo.transition(id, { status: "pending" }, { status: "running", stateDeadline: past });
    expect((await repo.listExpiredDeadlines(new Date())).map((r) => r.id)).toContain(id);

    await repo.transition(id, { status: "running" }, { status: "succeeded", finished: true });
    expect(await repo.listExpiredDeadlines(new Date())).toHaveLength(0);
  });

  it("journal: appendEvent is idempotent on (run_id, seq) and listEvents replays in order", async () => {
    const id = await createRun();
    const at = new Date();
    await repo.appendEvent({ runId: id, seq: 1, type: "run.started", payload: {}, createdAt: at });
    await repo.appendEvent({
      runId: id,
      seq: 2,
      type: "state.entered",
      payload: { state: "Start" },
      createdAt: at,
    });
    // duplicate delivery
    await repo.appendEvent({
      runId: id,
      seq: 2,
      type: "state.entered",
      payload: {},
      createdAt: at,
    });

    const events = await repo.listEvents(id);
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "run.started"],
      [2, "state.entered"],
    ]);
    expect(await repo.nextSeq(id)).toBe(3);

    const tail = await repo.listEvents(id, 1);
    expect(tail).toHaveLength(1);
    expect(tail[0].seq).toBe(2);
  });

  it("allocates an ordered append batch in adjacent journal sequence numbers", async () => {
    const id = await createRun();

    const committed = await atomic(repo).appendEvents(id, [
      { type: "state.completed", payload: { state: "Start" } },
      { type: "state.transitioned", payload: { source: "Start", end: true } },
      { type: "finish", payload: { reason: "completed" } },
    ]);

    expect(committed.map((event) => [event.seq, event.type])).toEqual([
      [1, "state.completed"],
      [2, "state.transitioned"],
      [3, "finish"],
    ]);
    expect((await repo.listEvents(id)).map((event) => event.payload)).toEqual([
      { state: "Start" },
      { source: "Start", end: true },
      { reason: "completed" },
    ]);
  });

  it("commits a CAS transition and its ordered events together", async () => {
    const id = await createRun();

    const result = await atomic(repo).transitionWithEvents(
      id,
      { status: "pending", currentState: "Start" },
      { status: "running", currentState: null },
      [
        { type: "state.completed", payload: { state: "Start" } },
        { type: "state.transitioned", payload: { source: "Start", end: true } },
      ]
    );

    expect(result.transitioned).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "state.completed",
      "state.transitioned",
    ]);
    expect(await repo.findById(id)).toMatchObject({ status: "running", currentState: null });
    expect((await repo.listEvents(id)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("changes neither row nor journal when transition CAS loses", async () => {
    const id = await createRun();

    const result = await atomic(repo).transitionWithEvents(
      id,
      { status: "running", currentState: "Start" },
      { status: "succeeded", currentState: null },
      [{ type: "finish", payload: { reason: "completed" } }]
    );

    expect(result).toEqual({ transitioned: false, events: [] });
    expect(await repo.findById(id)).toMatchObject({ status: "pending", currentState: "Start" });
    expect(await repo.listEvents(id)).toEqual([]);
  });

  it("retries a 23505 collision with fresh allocation and preserves input order", async () => {
    const id = await createRun();
    const collisionDb = new CollisionQueryable(db, 2);
    const collisionRepo = atomic(new RoutineRunsRepo(collisionDb));

    const events = await collisionRepo.appendEvents(id, [
      { type: "state.completed", payload: { state: "Start" } },
      { type: "state.transitioned", payload: { source: "Start", end: true } },
    ]);

    expect(collisionDb.attempts).toBe(3);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "state.completed"],
      [2, "state.transitioned"],
    ]);
  });

  it("surfaces the eighth consecutive 23505 instead of dropping the batch", async () => {
    const id = await createRun();
    const collisionDb = new CollisionQueryable(db, 8);
    const collisionRepo = atomic(new RoutineRunsRepo(collisionDb));

    await expect(
      collisionRepo.appendEvents(id, [{ type: "state.entered", payload: { state: "Start" } }])
    ).rejects.toMatchObject({ code: "23505" });
    expect(collisionDb.attempts).toBe(8);
    expect(await repo.listEvents(id)).toEqual([]);
  });

  it("keeps concurrent append writers unique and gap-free", async () => {
    const id = await createRun();

    await Promise.all([
      atomic(repo).appendEvents(id, [
        { type: "state.entered", payload: { writer: "append", order: 1 } },
        { type: "state.completed", payload: { writer: "append", order: 2 } },
      ]),
      atomic(repo).appendEvents(id, [
        { type: "state.retrying", payload: { writer: "retry", order: 1 } },
        { type: "finish", payload: { writer: "retry", order: 2 } },
      ]),
    ]);

    const events = await repo.listEvents(id);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    for (const writer of ["append", "retry"]) {
      const writerEvents = events.filter(
        (event) => (event.payload as { writer?: string }).writer === writer
      );
      expect(writerEvents.map((event) => (event.payload as { order: number }).order)).toEqual([
        1, 2,
      ]);
    }
  });

  it("coordinates concurrent append and transition writers", async () => {
    const id = await createRun();
    const [appended, transitioned] = await Promise.all([
      atomic(repo).appendEvents(id, [{ type: "state.entered", payload: { state: "Start" } }]),
      atomic(repo).transitionWithEvents(
        id,
        { status: "pending", currentState: "Start" },
        { status: "running", currentState: "Next" },
        [{ type: "state.transitioned", payload: { source: "Start", target: "Next" } }]
      ),
    ]);

    expect(appended).toHaveLength(1);
    expect(transitioned.transitioned).toBe(true);
    expect((await repo.listEvents(id)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("persists events only for the winner of competing transition batches", async () => {
    const id = await createRun();

    const results = await Promise.all([
      atomic(repo).transitionWithEvents(
        id,
        { status: "pending", currentState: "Start" },
        { status: "running", currentState: "A" },
        [{ type: "state.transitioned", payload: { source: "Start", target: "A" } }]
      ),
      atomic(repo).transitionWithEvents(
        id,
        { status: "pending", currentState: "Start" },
        { status: "running", currentState: "B" },
        [{ type: "state.transitioned", payload: { source: "Start", target: "B" } }]
      ),
    ]);

    expect(results.filter((result) => result.transitioned)).toHaveLength(1);
    expect(results.filter((result) => !result.transitioned)).toHaveLength(1);
    const run = await repo.findById(id);
    const events = await repo.listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ target: run?.currentState });
  });
});
