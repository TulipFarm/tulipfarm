import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { GitSyncService, SoulLoader, SoulRoutine } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { StreamHub } from "../chat/stream-hub";
import { runPgMigrations } from "../pg-migrate";
import { routineForgeTool } from "../platform/tools";
import { makePglite } from "../test/pglite";
import { RoutineRunDriver, type RoutineSandbox } from "./driver";
import type { RoutineRunJob, RoutineWakeJob } from "./jobs";
import { RoutineRegistry } from "./registry";
import { RoutineRunsRepo } from "./repo";
import { RoutineTriggerService } from "./trigger-service";

/**
 * Productionization proof (ROUT-V1-004 → runtime): a routine authored through the
 * Information Architect's `routine_forge` tool — the same call the routine-forge skill
 * makes — is valid, loads through the registry, and drives to `succeeded`. Exercises an
 * operation(tool:) state with an actionDataFilter, a switch expression, and an inject end.
 */
const FORGED: Record<string, unknown> = {
  id: "lead-welcome",
  version: "1.0",
  name: "Lead Welcome",
  start: "Fetch",
  "x-triggers": [{ type: "manual" }, { type: "cron", schedule: "0 9 * * *" }],
  "x-inputs": { type: "object", properties: { since: { type: "string" } } },
  functions: [{ name: "search", operation: "tool:record_search" }],
  states: [
    {
      name: "Fetch",
      type: "operation",
      actions: [
        {
          functionRef: { refName: "search", arguments: { type: "lead" } },
          actionDataFilter: { toStateData: "leads" },
        },
      ],
      transition: "Decide",
    },
    {
      name: "Decide",
      type: "switch",
      dataConditions: [{ condition: "context.leads.count > 0", transition: "Done" }],
      defaultCondition: { end: true },
    },
    { name: "Done", type: "inject", data: { welcomed: true }, end: true },
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

describe("forge → run (routine_forge output is runnable)", () => {
  let soulPath: string;
  let db: PGlite;
  let runs: RoutineRunsRepo;
  let registry: RoutineRegistry;
  let service: RoutineTriggerService;
  let driver: RoutineRunDriver;
  let queue: Array<{ runId: string }>;

  beforeEach(async () => {
    soulPath = mkdtempSync(join(tmpdir(), "forge-run-"));
    db = await makePglite();
    await runPgMigrations(db);
    runs = new RoutineRunsRepo(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(soulPath, { recursive: true, force: true });
  });

  it("forges a routine, loads it via the registry, and runs it end-to-end", async () => {
    // 1. Author it exactly as the routine-forge skill would.
    const withSync = vi.fn(async () => {});
    const gitSync = { path: soulPath, withSync } as unknown as GitSyncService;
    const forge = await routineForgeTool.handler(
      { name: "lead-welcome", definition: FORGED },
      { gitSync, onRoutinesChanged: async () => {} }
    );
    expect(forge).toMatchObject({ success: true, data: { committed: true } });

    // 2. Load the committed routine.yaml through the same registry boot uses.
    const config = parseYaml(
      readFileSync(join(soulPath, "routines", "lead-welcome", "routine.yaml"), "utf8")
    );
    const map = new Map<string, SoulRoutine>([
      ["lead-welcome", { name: "lead-welcome", config, hasHooks: false }],
    ]);
    const loader = { routines: map, reload: vi.fn() } as unknown as SoulLoader;
    const log = { error: vi.fn(), warn: vi.fn() };
    registry = new RoutineRegistry(loader, log);
    registry.refresh();
    // Registry accepted it as a valid routine (no load error).
    expect(registry.get("lead-welcome")).toBeDefined();

    // 3. Drive a manual trigger to completion.
    queue = [];
    const enqueuers = {
      enqueueRun: async (job: RoutineRunJob) => {
        queue.push({ runId: job.runId });
      },
      enqueueWake: async (job: RoutineWakeJob & { startAfter?: Date }) => {
        queue.push({ runId: job.runId });
      },
    };
    service = new RoutineTriggerService({ registry, runs, enqueuers, log });
    driver = new RoutineRunDriver({
      runs,
      registry,
      hub: new StreamHub(),
      sandbox: realJsSandbox(),
      // tool:record_search stands in — returns a lead count so the switch takes Done.
      actionExecutor: vi.fn(async () => ({ count: 2 })),
      enqueueWake: enqueuers.enqueueWake,
      log,
    });

    const { runId } = await service.trigger("lead-welcome", { type: "manual", payload: {} });
    for (let i = 0; i < 20 && queue.length > 0; i++) {
      const job = queue.shift();
      if (job) await driver.drive(job.runId);
    }

    const run = await runs.findById(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.output).toMatchObject({ welcomed: true, leads: { count: 2 } });
  });
});
