import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import type { SoulLoader, SoulRoutine } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamHub } from "../chat/stream-hub";
import { DOMAIN_EVENTS } from "../domain-events";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { RoutineRunDriver, type RoutineSandbox } from "./driver";
import type { RoutineRunJob, RoutineWakeJob } from "./jobs";
import { RoutineRegistry } from "./registry";
import { RoutineRunsRepo } from "./repo";
import { RoutineTriggerService, subscribeRoutineEventTriggers } from "./trigger-service";

/**
 * AC-V1-001: a routine using ALL FIVE V1 state types (operation/switch/foreach/sleep/
 * inject) and declaring ALL FIVE V1 trigger types (event/manual/cron/webhook/agent)
 * runs end-to-end. This wires the real trigger service → runs repo → driver → engine
 * with an in-memory queue standing in for pg-boss (same at-least-once contract).
 */
const FULL_ROUTINE: Record<string, unknown> = {
  id: "full-surface",
  version: "1.0",
  name: "Full V1 Surface",
  start: "Seed",
  "x-triggers": [
    { type: "manual" },
    { type: "cron", schedule: "0 9 * * *" },
    { type: "webhook", secret_ref: "hook-secret" },
    { type: "event", event: "resource.created" },
    { type: "agent" },
  ],
  functions: [{ name: "record", operation: "tool:resource_create" }],
  retries: [{ name: "std", maxAttempts: 2, delay: "PT1S" }],
  states: [
    {
      name: "Seed",
      type: "inject",
      data: { items: [1, 2], threshold: 1 },
      transition: "Gate",
    },
    {
      name: "Gate",
      type: "switch",
      dataConditions: [
        { condition: "context.items.length > context.threshold", transition: "Work" },
      ],
      defaultCondition: { end: true },
    },
    {
      name: "Work",
      type: "foreach",
      inputCollection: "context.items",
      iterationParam: "item",
      actions: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: routine expression DSL
        { functionRef: { refName: "record", arguments: { n: "${ item }" } }, retryRef: "std" },
      ],
      transition: "Cooldown",
    },
    { name: "Cooldown", type: "sleep", duration: "PT1S", transition: "Done" },
    { name: "Done", type: "inject", data: { finished: true }, end: true },
  ],
};

function realJsSandbox(): RoutineSandbox {
  return {
    runExpression: async (code, scope) => {
      const fn = new Function(...Object.keys(scope), `return (${code});`);
      return fn(...Object.values(scope));
    },
    runRoutineHook: async () => null,
  };
}

describe("AC-V1-001 end-to-end (all 5 states + all 5 triggers)", () => {
  let db: PGlite;
  let runs: RoutineRunsRepo;
  let registry: RoutineRegistry;
  let service: RoutineTriggerService;
  let driver: RoutineRunDriver;
  let queue: Array<{ runId: string; opts?: { approvalOutcome?: "approved" | "denied" } }>;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    runs = new RoutineRunsRepo(db);

    const map = new Map<string, SoulRoutine>([
      ["full-surface", { name: "full-surface", config: FULL_ROUTINE, hasHooks: false }],
    ]);
    const loader = { routines: map, reload: vi.fn() } as unknown as SoulLoader;
    const log = { error: vi.fn(), warn: vi.fn() };
    registry = new RoutineRegistry(loader, log);
    registry.refresh();

    queue = [];
    const enqueuers = {
      enqueueRun: async (job: RoutineRunJob) => {
        queue.push({ runId: job.runId });
      },
      enqueueWake: async (job: RoutineWakeJob & { startAfter?: Date }) => {
        queue.push({
          runId: job.runId,
          opts: job.reason === "approval" ? { approvalOutcome: job.decision } : undefined,
        });
      },
    };
    service = new RoutineTriggerService({ registry, runs, enqueuers, log });
    driver = new RoutineRunDriver({
      runs,
      registry,
      hub: new StreamHub(),
      sandbox: realJsSandbox(),
      actionExecutor: vi.fn(async (_fn, args) => ({ recorded: args })),
      enqueueWake: enqueuers.enqueueWake,
      log,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  /** Drain the in-memory queue like the pg-boss workers would (ignoring startAfter). */
  async function drain(): Promise<void> {
    for (let i = 0; i < 20 && queue.length > 0; i++) {
      const job = queue.shift();
      if (job) await driver.drive(job.runId, job.opts);
    }
  }

  it("runs the full-surface routine end-to-end from a manual trigger", async () => {
    const { runId } = await service.trigger("full-surface", { type: "manual", payload: {} });
    await drain();

    const run = await runs.findById(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.output).toMatchObject({ finished: true });

    const events = await runs.listEvents(runId);
    const states = events
      .filter((e) => e.type === "state.entered")
      .map((e) => (e.payload as { state: string }).state);
    expect(states).toEqual(["Seed", "Gate", "Work", "Cooldown", "Done"]);
    expect(events.filter((e) => e.type === "action.completed")).toHaveLength(2); // foreach x2
    expect(events.some((e) => e.type === "run.sleeping")).toBe(true);
    expect(events[events.length - 1].type).toBe("finish");
  });

  it("every declared trigger type starts a run", async () => {
    for (const type of ["manual", "cron", "webhook", "agent"] as const) {
      const { runId } = await service.trigger("full-surface", { type, payload: {} });
      expect((await runs.findById(runId))?.trigger.type).toBe(type);
    }

    // event trigger via the domain bus
    const bus = new EventEmitter();
    subscribeRoutineEventTriggers(bus, service, registry, undefined, {
      error: vi.fn(),
      warn: vi.fn(),
    });
    const before = queue.length;
    bus.emit(DOMAIN_EVENTS.RESOURCE_CREATED, { resourceType: "ticket" });
    await vi.waitFor(() => expect(queue.length).toBeGreaterThan(before));

    await drain();
    const all = await runs.listBySlug("full-surface", 50);
    expect(all).toHaveLength(5);
    expect(new Set(all.map((r) => r.trigger.type))).toEqual(
      new Set(["manual", "cron", "webhook", "agent", "event"])
    );
    expect(all.every((r) => r.status === "succeeded")).toBe(true);
  });
});
