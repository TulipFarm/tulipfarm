import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import type { SoulLoader, SoulRoutine } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMAIN_EVENTS } from "../domain-events";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import type { RoutineRunJob } from "./jobs";
import { RoutineRegistry } from "./registry";
import { RoutineRunsRepo } from "./repo";
import {
  RoutineTriggerError,
  RoutineTriggerService,
  subscribeRoutineEventTriggers,
} from "./trigger-service";

function makeRegistry(routines: Record<string, Record<string, unknown>>): RoutineRegistry {
  const map = new Map<string, SoulRoutine>();
  for (const [name, config] of Object.entries(routines)) {
    map.set(name, { name, config, hasHooks: false });
  }
  const loader = { routines: map, reload: vi.fn() } as unknown as SoulLoader;
  const registry = new RoutineRegistry(loader, { error: vi.fn(), warn: vi.fn() });
  registry.refresh();
  return registry;
}

const EVENT_ROUTINE: Record<string, unknown> = {
  id: "on-ticket",
  version: "1.0",
  start: "S",
  "x-triggers": [
    {
      type: "event",
      event: "resource.created",
      filter: "trigger.payload.resourceType === 'ticket'",
    },
    { type: "manual" },
  ],
  functions: [{ name: "noop", operation: "tool:resource_search" }],
  states: [
    { name: "S", type: "operation", actions: [{ functionRef: { refName: "noop" } }], end: true },
  ],
};

const LOG = { error: vi.fn(), warn: vi.fn() };

describe("RoutineTriggerService", () => {
  let db: PGlite;
  let runs: RoutineRunsRepo;
  let enqueued: RoutineRunJob[];

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    runs = new RoutineRunsRepo(db);
    enqueued = [];
  });

  afterEach(async () => {
    await db.close();
  });

  function makeService(
    registry: RoutineRegistry,
    evalFilter?: (c: string, s: Record<string, unknown>) => Promise<unknown>
  ) {
    return new RoutineTriggerService({
      registry,
      runs,
      enqueuers: {
        enqueueRun: async (job) => {
          enqueued.push(job);
        },
        enqueueWake: async () => {},
      },
      evalFilter,
      log: LOG,
    });
  }

  it("rejects undeclared trigger types", async () => {
    const service = makeService(makeRegistry({ "on-ticket": EVENT_ROUTINE }));
    await expect(service.trigger("on-ticket", { type: "cron" })).rejects.toThrow(
      RoutineTriggerError
    );
    await expect(service.trigger("on-ticket", { type: "cron" })).rejects.toThrow(
      /does not declare/
    );
  });

  it("creates the run with pinned snapshot + hash and enqueues routine-run", async () => {
    const service = makeService(makeRegistry({ "on-ticket": EVENT_ROUTINE }));
    const { runId } = await service.trigger("on-ticket", {
      type: "manual",
      payload: { a: 1 },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ runId, slug: "on-ticket" });
    const run = await runs.findById(runId);
    expect(run?.definitionSnapshot.id).toBe("on-ticket");
    expect(run?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run?.currentState).toBe("S");
  });

  describe("event triggers via the domain bus", () => {
    it("starts matching routines, honoring the filter expression", async () => {
      const registry = makeRegistry({ "on-ticket": EVENT_ROUTINE });
      const evalFilter = vi.fn(async (code: string, scope: Record<string, unknown>) => {
        const fn = new Function(...Object.keys(scope), `return (${code});`);
        return fn(...Object.values(scope));
      });
      const service = makeService(registry, evalFilter);
      const bus = new EventEmitter();
      subscribeRoutineEventTriggers(bus, service, registry, evalFilter, LOG);

      bus.emit(DOMAIN_EVENTS.RESOURCE_CREATED, { resourceType: "invoice", resourceId: "1" });
      await vi.waitFor(() => expect(evalFilter).toHaveBeenCalled());
      expect(enqueued).toHaveLength(0); // filter rejected

      bus.emit(DOMAIN_EVENTS.RESOURCE_CREATED, { resourceType: "ticket", resourceId: "2" });
      await vi.waitFor(() => expect(enqueued).toHaveLength(1));
      const run = await runs.findById(enqueued[0].runId);
      expect(run?.trigger).toMatchObject({
        type: "event",
        payload: { resourceType: "ticket" },
      });
    });

    it("ignores events no routine subscribes to", async () => {
      const registry = makeRegistry({ "on-ticket": EVENT_ROUTINE });
      const service = makeService(registry);
      const bus = new EventEmitter();
      subscribeRoutineEventTriggers(bus, service, registry, undefined, LOG);

      bus.emit(DOMAIN_EVENTS.CONVERSATION_CREATED, { conversationId: "c1" });
      await new Promise((r) => setTimeout(r, 20));
      expect(enqueued).toHaveLength(0);
    });
  });
});
