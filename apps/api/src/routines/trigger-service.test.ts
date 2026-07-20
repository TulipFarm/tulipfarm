import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import type { SoulLoader, SoulRoutine } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamHub } from "../chat/stream-hub";
import { DOMAIN_EVENTS } from "../domain-events";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { RoutineRunDriver } from "./driver";
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

const ALL_TRIGGER_ROUTINE: Record<string, unknown> = {
  id: "all-triggers",
  version: "1.0",
  start: "Done",
  "x-triggers": [
    { type: "manual" },
    { type: "event", event: "resource.created" },
    { type: "webhook", secret_ref: "first-webhook" },
    { type: "cron", schedule: "0 9 * * *" },
    { type: "agent" },
    { type: "manual" },
    { type: "event", event: "resource.created" },
  ],
  states: [{ name: "Done", type: "inject", data: {}, end: true }],
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

  function makeDriver(registry: RoutineRegistry): RoutineRunDriver {
    return new RoutineRunDriver({
      runs,
      registry,
      hub: new StreamHub(),
      sandbox: {
        runExpression: async () => true,
        runRoutineHook: async () => null,
      },
      actionExecutor: async () => ({}),
      enqueueWake: async () => {},
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

  it("accepts a matching explicit Trigger index and persists it", async () => {
    const service = makeService(makeRegistry({ "all-triggers": ALL_TRIGGER_ROUTINE }));
    const { runId } = await service.trigger("all-triggers", {
      type: "manual",
      triggerIndex: 5,
    });

    expect((await runs.findById(runId))?.trigger).toMatchObject({
      type: "manual",
      triggerIndex: 5,
    });
  });

  it.each([
    ["negative", -1, "manual"],
    ["out of bounds", 99, "manual"],
    ["non-integer", 1.5, "manual"],
    ["type mismatch", 1, "manual"],
  ] as const)("rejects a %s explicit Trigger index before creating a Run", async (_case, index, type) => {
    const service = makeService(makeRegistry({ "all-triggers": ALL_TRIGGER_ROUTINE }));

    await expect(
      service.trigger("all-triggers", { type, triggerIndex: index })
    ).rejects.toMatchObject({ code: "trigger_not_declared" });
    expect(enqueued).toHaveLength(0);
    expect(await runs.listBySlug("all-triggers")).toHaveLength(0);
  });

  it("deterministically selects the first matching Trigger when no index is supplied", async () => {
    const service = makeService(makeRegistry({ "all-triggers": ALL_TRIGGER_ROUTINE }));
    const { runId } = await service.trigger("all-triggers", { type: "manual" });

    expect((await runs.findById(runId))?.trigger).toMatchObject({
      type: "manual",
      triggerIndex: 0,
    });
  });

  it.each([
    ["manual", 0],
    ["event", 1],
    ["webhook", 2],
    ["cron", 3],
    ["agent", 4],
  ] as const)("persists %s Trigger identity and journals it in run.started", async (type, index) => {
    const registry = makeRegistry({ "all-triggers": ALL_TRIGGER_ROUTINE });
    const service = makeService(registry);
    const { runId } = await service.trigger("all-triggers", { type });

    expect((await runs.findById(runId))?.trigger).toMatchObject({
      type,
      triggerIndex: index,
    });

    await makeDriver(registry).drive(runId);
    const started = (await runs.listEvents(runId)).find((event) => event.type === "run.started");
    expect(started?.payload).toMatchObject({
      slug: "all-triggers",
      trigger: type,
      triggerIndex: index,
    });
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
        triggerIndex: 0,
        payload: { resourceType: "ticket" },
      });
    });

    it("threads each matching event Trigger's exact array index", async () => {
      const registry = makeRegistry({ "all-triggers": ALL_TRIGGER_ROUTINE });
      const service = makeService(registry);
      const bus = new EventEmitter();
      subscribeRoutineEventTriggers(bus, service, registry, undefined, LOG);

      bus.emit(DOMAIN_EVENTS.RESOURCE_CREATED, { resourceType: "ticket" });
      await vi.waitFor(() => expect(enqueued).toHaveLength(2));

      const startedRuns = await Promise.all(enqueued.map((job) => runs.findById(job.runId)));
      expect(startedRuns.map((run) => run?.trigger.triggerIndex)).toEqual([1, 6]);
    });

    it("starts routines on integration.event with a protocol/event filter (Slack ingress)", async () => {
      const routine: Record<string, unknown> = {
        ...EVENT_ROUTINE,
        id: "on-slack-join",
        "x-triggers": [
          {
            type: "event",
            event: "integration.event",
            filter:
              "trigger.payload.integration === 'slack' && trigger.payload.event === 'member_joined_channel'",
          },
        ],
      };
      const registry = makeRegistry({ "on-slack-join": routine });
      const evalFilter = vi.fn(async (code: string, scope: Record<string, unknown>) => {
        const fn = new Function(...Object.keys(scope), `return (${code});`);
        return fn(...Object.values(scope));
      });
      const service = makeService(registry, evalFilter);
      const bus = new EventEmitter();
      subscribeRoutineEventTriggers(bus, service, registry, evalFilter, LOG);

      bus.emit(DOMAIN_EVENTS.INTEGRATION_EVENT, {
        integration: "slack",
        protocol: "slack",
        event: "reaction_added",
        eventId: "e1",
        payload: {},
      });
      await vi.waitFor(() => expect(evalFilter).toHaveBeenCalled());
      expect(enqueued).toHaveLength(0); // wrong event type — filter rejected

      bus.emit(DOMAIN_EVENTS.INTEGRATION_EVENT, {
        integration: "slack",
        protocol: "slack",
        event: "member_joined_channel",
        eventId: "e2",
        payload: { channel: "C1", user: "U1" },
      });
      await vi.waitFor(() => expect(enqueued).toHaveLength(1));
      const run = await runs.findById(enqueued[0].runId);
      expect(run?.trigger).toMatchObject({
        type: "event",
        payload: { integration: "slack", event: "member_joined_channel" },
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
