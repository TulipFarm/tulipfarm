import { assembleSystemPrompt } from "@tulipfarm/agent-runtime";
import { describe, expect, it } from "vitest";
import type { PlatformRuntimeContext } from "./tools";
import {
  completeStateTool,
  completeTaskTool,
  getCurrentTimeTool,
  PLATFORM_RUNTIME_TOOLS,
  validateArtifactTool,
} from "./tools";

describe("completeTaskTool", () => {
  it("returns the structured completion result handed back to the front desk", async () => {
    const res = await completeTaskTool.handler(
      { status: "success", summary: "built invoices", result: { resources: 1 } },
      {}
    );
    expect(res).toMatchObject({
      success: true,
      data: {
        status: "success",
        summary: "built invoices",
        result: { resources: 1 },
        completed: true,
      },
    });
  });

  it("returns validation_error for an invalid status", async () => {
    const res = await completeTaskTool.handler({ status: "weird" }, {});
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

describe("validateArtifactTool", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  };

  it("returns valid:true when artifact matches schema", async () => {
    const res = await validateArtifactTool.handler({ artifact: { name: "Alice" }, schema }, {});
    expect(res).toEqual({ success: true, data: { valid: true } });
  });

  it("returns valid:false with errors when artifact fails schema", async () => {
    const res = await validateArtifactTool.handler({ artifact: { name: 123 }, schema }, {});
    expect(res).toMatchObject({ success: true, data: { valid: false } });
    if (!res.success) throw new Error("expected success");
    const data = res.data as { valid: boolean; errors: unknown[] };
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it("returns internal_error for an invalid schema", async () => {
    const res = await validateArtifactTool.handler(
      { artifact: {}, schema: { type: "not-a-real-type" } },
      {}
    );
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("returns validation_error when args are missing schema", async () => {
    const res = await validateArtifactTool.handler({ artifact: {} }, {});
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── transfer_to_agent ─────────────────────────────────────────────────────────

describe("completeStateTool", () => {
  const routineCtx = { routineId: "daily-digest", runId: "run-001" };

  it("returns completion receipt with output", async () => {
    const ctx: PlatformRuntimeContext = { routineContext: routineCtx };
    const res = await completeStateTool.handler({ output: { sent: 5 } }, ctx);
    expect(res).toEqual({
      success: true,
      data: { routineId: "daily-digest", runId: "run-001", completed: true, output: { sent: 5 } },
    });
  });

  it("sets output to null when omitted", async () => {
    const ctx: PlatformRuntimeContext = { routineContext: routineCtx };
    const res = await completeStateTool.handler({}, ctx);
    expect(res).toMatchObject({ success: true, data: { completed: true, output: null } });
  });

  it("returns internal_error when no routineContext", async () => {
    const res = await completeStateTool.handler({}, {});
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });
});

describe("get_current_time", () => {
  const ctx: PlatformRuntimeContext = {};

  /** Narrow the result union so a failure surfaces its message instead of an undefined read. */
  function data(result: Awaited<ReturnType<typeof getCurrentTimeTool.handler>>): {
    current: string;
  } {
    if (!result.success) throw new Error(`expected success, got ${result.error.message}`);
    return result.data as { current: string };
  }

  it("reads the current time in the requested zone", async () => {
    const { current } = data(await getCurrentTimeTool.handler({ timezone: "Asia/Kolkata" }, ctx));
    expect(current).toContain("Asia/Kolkata");
    expect(current).toMatch(/^date: \w+, \d{2} \w+ \d{4}\ntime: \d{2}:\d{2} \(/);
  });

  it("defaults to UTC when no zone is given", async () => {
    expect(data(await getCurrentTimeTool.handler({}, ctx)).current).toContain("(UTC, UTC+00:00)");
  });

  it("renders in the same shape as the <current-context> block so the two cannot drift", async () => {
    const { current } = data(await getCurrentTimeTool.handler({ timezone: "UTC" }, ctx));
    const block = assembleSystemPrompt({
      governancePages: [],
      temporal: { now: new Date(), timezone: "UTC" },
    });
    // Same labelled lines, produced by the shared formatter.
    for (const line of current.split("\n")) {
      expect(block).toContain(`${line.split(":")[0]}:`);
    }
  });

  it("rejects an unknown argument rather than silently ignoring it", async () => {
    const result = await getCurrentTimeTool.handler({ zone: "Asia/Kolkata" }, ctx);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a validation failure");
    expect(result.error.code).toBe("validation_error");
  });

  it("is read-only and registered", () => {
    expect(getCurrentTimeTool.mutating).toBe(false);
    expect(PLATFORM_RUNTIME_TOOLS.map((t) => t.name)).toContain("get_current_time");
  });
});
