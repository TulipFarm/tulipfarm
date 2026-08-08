import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSyncService } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { routineForgeTool } from "./tools";

const VALID_DEFINITION: Record<string, unknown> = {
  id: "daily-report",
  version: "1.0",
  start: "Report",
  "x-triggers": [{ type: "cron", schedule: "0 9 * * *" }],
  functions: [{ name: "send", operation: "tool:resource_search" }],
  states: [
    {
      name: "Report",
      type: "operation",
      actions: [{ functionRef: { refName: "send" } }],
      end: true,
    },
  ],
};

describe("routine_forge", () => {
  let soulPath: string;
  let gitSync: GitSyncService;
  let withSync: ReturnType<typeof vi.fn>;
  let onRoutinesChanged: (() => Promise<void>) & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    soulPath = mkdtempSync(join(tmpdir(), "forge-"));
    withSync = vi.fn(async () => {});
    gitSync = { path: soulPath, withSync } as unknown as GitSyncService;
    onRoutinesChanged = vi.fn(async () => {}) as typeof onRoutinesChanged;
  });

  afterEach(() => {
    rmSync(soulPath, { recursive: true, force: true });
  });

  it("writes routine.yaml + hooks.ts, commits via withSync, no approval step", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: VALID_DEFINITION,
        hooks: "({ beforeHook(ctx) { return ctx; } })",
      },
      { gitSync, onRoutinesChanged }
    );
    expect(result).toMatchObject({
      success: true,
      data: { name: "daily-report", committed: true, hasHooks: true },
    });

    const yaml = parseYaml(
      readFileSync(join(soulPath, "routines", "daily-report", "routine.yaml"), "utf8")
    );
    expect(yaml).toMatchObject({ id: "daily-report", start: "Report" });
    expect(readFileSync(join(soulPath, "routines", "daily-report", "hooks.ts"), "utf8")).toContain(
      "beforeHook"
    );
    expect(withSync).toHaveBeenCalledWith("soul: forge routine daily-report");
    expect(onRoutinesChanged).toHaveBeenCalledOnce();
  });

  it("rejects deferred constructs BEFORE writing anything", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "bad",
        definition: {
          ...VALID_DEFINITION,
          id: "bad",
          "x-triggers": [{ type: "datetime", at: "2027-01-01" }],
        },
      },
      { gitSync, onRoutinesChanged }
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("deferred in V1");
    }
    expect(withSync).not.toHaveBeenCalled();
    expect(() => readFileSync(join(soulPath, "routines", "bad", "routine.yaml"))).toThrow();
  });

  it("rejects invalid slugs and schema violations", async () => {
    const badSlug = await routineForgeTool.handler(
      { name: "Bad Slug!", definition: VALID_DEFINITION },
      { gitSync }
    );
    expect(badSlug.success).toBe(false);

    const badSchema = await routineForgeTool.handler(
      { name: "ok-name", definition: { id: "x", bogus: true } },
      { gitSync }
    );
    expect(badSchema.success).toBe(false);
    expect(withSync).not.toHaveBeenCalled();
  });

  it("describes the required top-level fields so the model doesn't fall through to skill_create", () => {
    const { description } = routineForgeTool;
    for (const field of ["id", "version", "start", "states", "x-triggers"]) {
      expect(description).toContain(field);
    }
    expect(description.toLowerCase()).toContain("not skill_create");
  });
});
