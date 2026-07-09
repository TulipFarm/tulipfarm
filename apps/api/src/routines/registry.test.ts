import { EventEmitter } from "node:events";
import type { SoulLoader, SoulRoutine } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { RoutineRegistry, registerRoutineRegistryReload } from "./registry";

const VALID_CONFIG: Record<string, unknown> = {
  id: "daily-report",
  version: "1.0",
  start: "Report",
  "x-triggers": [{ type: "cron", schedule: "0 9 * * *" }],
  functions: [{ name: "sendReport", operation: "tool:resource_search" }],
  states: [
    {
      name: "Report",
      type: "operation",
      actions: [{ functionRef: { refName: "sendReport" } }],
      end: true,
    },
  ],
};

function makeLoader(routines: Record<string, Partial<SoulRoutine>>): SoulLoader {
  const map = new Map<string, SoulRoutine>();
  for (const [name, r] of Object.entries(routines)) {
    map.set(name, { name, config: {}, hasHooks: false, ...r });
  }
  return { routines: map, reload: vi.fn().mockResolvedValue(undefined) } as unknown as SoulLoader;
}

function makeLog() {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("RoutineRegistry", () => {
  it("validates routines on refresh and exposes valid ones", () => {
    const loader = makeLoader({
      "daily-report": { config: VALID_CONFIG, hookSource: "({ beforeHook(ctx){} })" },
    });
    const registry = new RoutineRegistry(loader, makeLog());
    registry.refresh();

    const routine = registry.get("daily-report");
    expect(routine?.definition.id).toBe("daily-report");
    expect(routine?.hookSource).toBe("({ beforeHook(ctx){} })");
    expect(registry.valid()).toHaveLength(1);
  });

  it("keeps invalid routines as error entries without crashing", () => {
    const loader = makeLoader({
      good: { config: VALID_CONFIG },
      bad: { config: { id: "bad", bogus: true } },
      deferred: {
        config: {
          ...VALID_CONFIG,
          id: "deferred",
          "x-triggers": [{ type: "datetime", at: "2027-01-01" }],
        },
      },
    });
    const registry = new RoutineRegistry(loader, makeLog());
    registry.refresh();

    expect(registry.get("good")).toBeDefined();
    expect(registry.get("bad")).toBeUndefined();
    const badEntry = registry.getEntry("bad");
    expect(badEntry?.ok).toBe(false);
    const deferredEntry = registry.getEntry("deferred");
    expect(deferredEntry?.ok).toBe(false);
    if (deferredEntry && !deferredEntry.ok) {
      expect(deferredEntry.loadError).toContain("deferred in V1");
    }
    expect(registry.list()).toHaveLength(3);
    expect(registry.valid()).toHaveLength(1);
  });

  it("drops entries for routines removed from the soul", () => {
    const loader = makeLoader({ "daily-report": { config: VALID_CONFIG } });
    const registry = new RoutineRegistry(loader, makeLog());
    registry.refresh();
    expect(registry.get("daily-report")).toBeDefined();

    (loader.routines as Map<string, SoulRoutine>).delete("daily-report");
    registry.refresh();
    expect(registry.get("daily-report")).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });
});

describe("registerRoutineRegistryReload", () => {
  it("reloads the soul and refreshes the registry on soul.synced", async () => {
    const loader = makeLoader({});
    const registry = new RoutineRegistry(loader, makeLog());
    const refresh = vi.spyOn(registry, "refresh");
    const gitSync = new EventEmitter();
    registerRoutineRegistryReload(gitSync, loader, registry, makeLog());

    gitSync.emit("soul.synced");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(loader.reload).toHaveBeenCalledOnce();
  });

  it("logs and survives a reload failure", async () => {
    const loader = makeLoader({});
    (loader.reload as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const registry = new RoutineRegistry(loader, makeLog());
    const log = makeLog();
    const gitSync = new EventEmitter();
    registerRoutineRegistryReload(gitSync, loader, registry, log);

    gitSync.emit("soul.synced");
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledOnce());
  });
});
