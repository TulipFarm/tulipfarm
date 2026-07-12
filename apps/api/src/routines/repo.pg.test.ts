import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { RoutineDefinition } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { RoutineRunsRepo } from "./repo";

const DEF = {
  id: "r",
  version: "1.0",
  start: "Start",
  "x-triggers": [{ type: "manual" }],
  states: [{ name: "Start", type: "inject", data: {}, end: true }],
} as unknown as RoutineDefinition;

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
});
