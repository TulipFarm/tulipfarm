import type { SoulLoader, SoulRoutine } from "@tulipfarm/soul";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { RoutineRegistry } from "./registry";
import { ROUTINE_CRON_QUEUE, reconcileRoutineSchedules } from "./schedules";

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

function cronRoutine(id: string, schedule: string, timezone?: string): Record<string, unknown> {
  return {
    id,
    version: "1.0",
    start: "S",
    "x-triggers": [{ type: "cron", schedule, ...(timezone ? { timezone } : {}) }],
    states: [{ name: "S", type: "inject", data: {}, end: true }],
  };
}

function makeBoss(existing: Array<{ key: string; cron: string; timezone: string }>) {
  return {
    getSchedules: vi.fn(async () => existing.map((s) => ({ ...s, name: ROUTINE_CRON_QUEUE }))),
    schedule: vi.fn(async () => {}),
    unschedule: vi.fn(async () => {}),
  } as unknown as PgBoss;
}

const LOG = { error: vi.fn(), warn: vi.fn() };

describe("reconcileRoutineSchedules", () => {
  it("schedules new cron triggers with keyed schedules and tz", async () => {
    const registry = makeRegistry({
      "daily-report": cronRoutine("daily-report", "0 9 * * *", "Europe/Berlin"),
    });
    const boss = makeBoss([]);

    await reconcileRoutineSchedules(boss, registry, LOG);

    expect(boss.schedule).toHaveBeenCalledWith(
      ROUTINE_CRON_QUEUE,
      "0 9 * * *",
      { slug: "daily-report", triggerIndex: 0 },
      { key: "daily-report.0", tz: "Europe/Berlin" }
    );
    expect(boss.unschedule).not.toHaveBeenCalled();
  });

  it("leaves unchanged schedules alone and updates changed crons", async () => {
    const registry = makeRegistry({
      same: cronRoutine("same", "0 9 * * *"),
      changed: cronRoutine("changed", "30 6 * * 1"),
    });
    const boss = makeBoss([
      { key: "same.0", cron: "0 9 * * *", timezone: "UTC" },
      { key: "changed.0", cron: "0 0 * * *", timezone: "UTC" },
    ]);

    await reconcileRoutineSchedules(boss, registry, LOG);

    expect(boss.schedule).toHaveBeenCalledTimes(1);
    expect(boss.schedule).toHaveBeenCalledWith(
      ROUTINE_CRON_QUEUE,
      "30 6 * * 1",
      { slug: "changed", triggerIndex: 0 },
      { key: "changed.0", tz: "UTC" }
    );
  });

  it("unschedules keys whose routine disappeared (deletion dedup)", async () => {
    const registry = makeRegistry({});
    const boss = makeBoss([{ key: "gone.0", cron: "0 9 * * *", timezone: "UTC" }]);

    await reconcileRoutineSchedules(boss, registry, LOG);

    expect(boss.unschedule).toHaveBeenCalledWith(ROUTINE_CRON_QUEUE, "gone.0");
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("ignores invalid routines and non-cron triggers", async () => {
    const registry = makeRegistry({
      manualOnly: {
        id: "manualOnly",
        version: "1.0",
        start: "S",
        "x-triggers": [{ type: "manual" }],
        states: [{ name: "S", type: "inject", data: {}, end: true }],
      },
      broken: { id: "broken" },
    });
    const boss = makeBoss([]);

    await reconcileRoutineSchedules(boss, registry, LOG);
    expect(boss.schedule).not.toHaveBeenCalled();
  });
});
