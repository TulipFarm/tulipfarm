import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { RoutineDefinition } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamHub } from "../chat/stream-hub";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { type ActionExecutor, RoutineRunDriver, type RoutineSandbox } from "./driver";
import type { RoutineRegistry } from "./registry";
import { RoutineRunsRepo } from "./repo";

function makeSandbox(hookResults: Record<string, unknown> = {}): RoutineSandbox {
  return {
    // Real-JS stand-in for the isolated-vm expression adapter.
    runExpression: vi.fn(async (code: string, scope: Record<string, unknown>) => {
      const fn = new Function(...Object.keys(scope), `return (${code});`);
      return fn(...Object.values(scope));
    }),
    runRoutineHook: vi.fn(async (_src, fnName) => hookResults[fnName] ?? null),
  };
}

function makeRegistry(hookSource?: string): RoutineRegistry {
  return {
    get: vi.fn(() => ({
      slug: "test",
      definition: {} as RoutineDefinition,
      hookSource,
      hookHash: hookSource ? "hash" : undefined,
    })),
  } as unknown as RoutineRegistry;
}

const LOG = { error: vi.fn(), warn: vi.fn() };

describe("RoutineRunDriver (PGlite)", () => {
  let db: PGlite;
  let runs: RoutineRunsRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    runs = new RoutineRunsRepo(db);
    LOG.error.mockClear();
    LOG.warn.mockClear();
  });

  afterEach(async () => {
    await db.close();
  });

  function makeDriver(overrides: {
    actionExecutor?: ActionExecutor;
    sandbox?: RoutineSandbox;
    registry?: RoutineRegistry;
    enqueueWake?: ReturnType<typeof vi.fn>;
    requestApproval?: ReturnType<typeof vi.fn>;
    recordRun?: ReturnType<typeof vi.fn>;
  }) {
    const enqueueWake = overrides.enqueueWake ?? vi.fn(async () => {});
    const recordRun = overrides.recordRun ?? vi.fn();
    const driver = new RoutineRunDriver({
      runs,
      registry: overrides.registry ?? makeRegistry(),
      hub: new StreamHub(),
      sandbox: overrides.sandbox ?? makeSandbox(),
      actionExecutor: overrides.actionExecutor ?? vi.fn(async () => ({ ok: true })),
      requestApproval: overrides.requestApproval as never,
      enqueueWake: enqueueWake as never,
      recordRun: recordRun as never,
      log: LOG,
    });
    return { driver, enqueueWake, recordRun };
  }

  async function createRun(def: RoutineDefinition, context: Record<string, unknown> = {}) {
    const id = randomUUID();
    await runs.create({
      id,
      routineSlug: "test",
      definitionSnapshot: def,
      definitionHash: "h",
      currentState: def.start,
      context,
      trigger: { type: "manual" },
    });
    return id;
  }

  const MULTI_STATE = {
    id: "multi",
    version: "1.0",
    start: "Seed",
    functions: [{ name: "doWork", operation: "tool:resource_create" }],
    "x-triggers": [{ type: "manual" }],
    states: [
      { name: "Seed", type: "inject", data: { amount: 700 }, transition: "Gate" },
      {
        name: "Gate",
        type: "switch",
        dataConditions: [{ condition: "context.amount > 500", transition: "Work" }],
        defaultCondition: { end: true },
      },
      {
        name: "Work",
        type: "operation",
        actions: [{ functionRef: { refName: "doWork" } }],
        end: true,
      },
    ],
  } as unknown as RoutineDefinition;

  it("drives a multi-state run to completion, journaling every event", async () => {
    const actionExecutor = vi.fn(async () => ({ created: true }));
    const { driver } = makeDriver({ actionExecutor });
    const id = await createRun(MULTI_STATE);

    await driver.drive(id);

    const run = await runs.findById(id);
    expect(run?.status).toBe("succeeded");
    expect(run?.output).toMatchObject({ amount: 700 });
    expect(run?.finishedAt).not.toBeNull();
    expect(actionExecutor).toHaveBeenCalledOnce();

    const events = await runs.listEvents(id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("state.entered");
    expect(types[types.length - 1]).toBe("finish");
    // seqs strictly ascending from 1
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("suspends on sleep, persists wake bookkeeping, and completes after wake", async () => {
    const def = {
      ...MULTI_STATE,
      id: "sleepy",
      start: "Nap",
      states: [
        { name: "Nap", type: "sleep", duration: "PT1S", transition: "Done" },
        { name: "Done", type: "inject", data: { woke: true }, end: true },
      ],
    } as unknown as RoutineDefinition;
    const { driver, enqueueWake } = makeDriver({});
    const id = await createRun(def);

    await driver.drive(id);
    let run = await runs.findById(id);
    expect(run?.status).toBe("sleeping");
    expect(run?.currentState).toBe("Done");
    expect(run?.wakeAt).not.toBeNull();
    expect(enqueueWake).toHaveBeenCalledWith(
      expect.objectContaining({ runId: id, reason: "sleep" })
    );

    // wake delivery (crash-restart equivalent: fresh drive call)
    await driver.drive(id);
    run = await runs.findById(id);
    expect(run?.status).toBe("succeeded");
    expect(run?.output).toMatchObject({ woke: true });

    // journal seqs never restarted (review B1): strictly ascending across the suspension
    const seqs = (await runs.listEvents(id)).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("is idempotent under duplicate deliveries (CAS loses quietly)", async () => {
    const actionExecutor = vi.fn(async () => ({ ok: true }));
    const { driver } = makeDriver({ actionExecutor });
    const id = await createRun(MULTI_STATE);

    await Promise.all([driver.drive(id), driver.drive(id)]);

    const run = await runs.findById(id);
    expect(run?.status).toBe("succeeded");
    // The Work action ran exactly once despite two deliveries.
    expect(actionExecutor).toHaveBeenCalledTimes(1);
  });

  it("schedules a delayed wake on retry outcomes and resumes to success", async () => {
    const def = {
      ...MULTI_STATE,
      id: "flaky",
      start: "Work",
      retries: [{ name: "std", maxAttempts: 3, delay: "PT1S" }],
      states: [
        {
          name: "Work",
          type: "operation",
          actions: [{ functionRef: { refName: "doWork" }, retryRef: "std" }],
          end: true,
        },
      ],
    } as unknown as RoutineDefinition;
    let calls = 0;
    const actionExecutor = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("flaky");
      return { ok: true };
    });
    const { driver, enqueueWake } = makeDriver({ actionExecutor });
    const id = await createRun(def);

    await driver.drive(id);
    let run = await runs.findById(id);
    expect(run?.status).toBe("sleeping");
    expect(run?.attemptCounts).toEqual({ Work: 1 });
    expect(enqueueWake).toHaveBeenCalledWith(expect.objectContaining({ reason: "retry" }));

    await driver.drive(id);
    run = await runs.findById(id);
    expect(run?.status).toBe("succeeded");
    expect(calls).toBe(2);
  });

  it("fails the run with the engine error when an action keeps failing", async () => {
    const def = {
      ...MULTI_STATE,
      id: "doomed",
      start: "Work",
      states: [
        {
          name: "Work",
          type: "operation",
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    } as unknown as RoutineDefinition;
    const { driver } = makeDriver({
      actionExecutor: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    const id = await createRun(def);

    await driver.drive(id);
    const run = await runs.findById(id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatchObject({ name: "action_failed", message: "nope" });
    const events = await runs.listEvents(id);
    expect(events[events.length - 1].type).toBe("error");
  });

  it("pauses on human_approval, records the approval id, resumes on approval", async () => {
    const def = {
      ...MULTI_STATE,
      id: "gated",
      start: "Gate",
      states: [
        {
          name: "Gate",
          type: "operation",
          "x-autonomy-level": "human_approval",
          "x-approval-channel": ["ui"],
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    } as unknown as RoutineDefinition;
    const approvalId = randomUUID();
    const requestApproval = vi.fn(async () => approvalId);
    const actionExecutor = vi.fn(async () => ({ ok: true }));
    const { driver } = makeDriver({ requestApproval, actionExecutor });
    const id = await createRun(def);

    await driver.drive(id);
    let run = await runs.findById(id);
    expect(run?.status).toBe("waiting_approval");
    expect(run?.approvalId).toBe(approvalId);
    expect(actionExecutor).not.toHaveBeenCalled();

    await driver.drive(id, { approvalOutcome: "approved" });
    run = await runs.findById(id);
    expect(run?.status).toBe("succeeded");
    expect(actionExecutor).toHaveBeenCalledOnce();
  });

  it("runs lifecycle + step hooks through the sandbox", async () => {
    const hookSource =
      "({ beforeHook(ctx){}, beforeReport(ctx){}, computeTotal(ctx,a){ return 9 } })";
    const def = {
      ...MULTI_STATE,
      id: "hooked",
      start: "Report",
      functions: [{ name: "computeTotal", operation: "hook:computeTotal" }],
      states: [
        {
          name: "Report",
          type: "operation",
          actions: [
            {
              functionRef: { refName: "computeTotal" },
              actionDataFilter: { toStateData: "context.total" },
            },
          ],
          end: true,
        },
      ],
    } as unknown as RoutineDefinition;
    const sandbox = makeSandbox({ computeTotal: 9 });
    const { driver } = makeDriver({ sandbox, registry: makeRegistry(hookSource) });
    const id = await createRun(def);

    await driver.drive(id);
    const run = await runs.findById(id);
    expect(run?.status).toBe("succeeded");
    expect(run?.output).toMatchObject({ total: 9 });

    const hookCalls = (sandbox.runRoutineHook as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1]
    );
    expect(hookCalls).toEqual(["beforeHook", "beforeReport", "computeTotal"]);
  });

  it("persists state_deadline before a timed state and clears it on transition", async () => {
    const def = {
      ...MULTI_STATE,
      id: "timed",
      start: "Slow",
      states: [
        {
          name: "Slow",
          type: "operation",
          timeouts: { stateExecTimeout: "PT30S" },
          actions: [{ functionRef: { refName: "doWork" } }],
          transition: "Done",
        },
        { name: "Done", type: "inject", data: {}, end: true },
      ],
    } as unknown as RoutineDefinition;
    const deadlines: Array<Date | null> = [];
    const actionExecutor = vi.fn(async () => {
      const row = await runs.findById(id);
      deadlines.push(row?.stateDeadline ?? null);
      return { ok: true };
    });
    const { driver } = makeDriver({ actionExecutor });
    const id = await createRun(def);

    await driver.drive(id);
    // deadline was set while the timed state's action ran…
    expect(deadlines[0]).toBeInstanceOf(Date);
    // …and cleared once the run completed.
    const run = await runs.findById(id);
    expect(run?.status).toBe("succeeded");
    expect(run?.stateDeadline).toBeNull();
  });

  it("reports terminal outcomes via recordRun (activity feed)", async () => {
    const recordRun = vi.fn();
    const { driver } = makeDriver({ recordRun });
    const okId = await createRun(MULTI_STATE);
    await driver.drive(okId);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "test", runId: okId, status: "succeeded" })
    );

    const doomed = {
      ...MULTI_STATE,
      id: "doomed",
      start: "Work",
      states: [
        {
          name: "Work",
          type: "operation",
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    } as unknown as RoutineDefinition;
    const failId = await createRun(doomed);
    const failDriver = makeDriver({
      recordRun,
      actionExecutor: vi.fn(async () => {
        throw new Error("nope");
      }),
    }).driver;
    await failDriver.drive(failId);
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: failId, status: "failed" })
    );
  });

  it("does nothing for terminal or unknown runs", async () => {
    const { driver } = makeDriver({});
    await driver.drive(randomUUID()); // unknown
    expect(LOG.warn).toHaveBeenCalled();

    const id = await createRun(MULTI_STATE);
    await runs.transition(id, { status: "pending" }, { status: "cancelled", finished: true });
    await driver.drive(id);
    const run = await runs.findById(id);
    expect(run?.status).toBe("cancelled");
  });
});
