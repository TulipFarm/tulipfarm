import { describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_MS, ToolRegistry } from "./registry";
import type { RequestContext, ToolDef } from "./types";

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "test_tool",
    tier: "platform",
    mutating: false,
    description: "A test tool",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_args, _ctx) => ({ success: true, data: "ok" }),
    ...overrides,
  };
}

const ctx: RequestContext = { userId: "u1", agentId: "a1" };

describe("ToolRegistry", () => {
  it("register + getAll returns all tools in insertion order", () => {
    const reg = new ToolRegistry();
    const t1 = makeTool({ name: "tool_a" });
    const t2 = makeTool({ name: "tool_b" });
    reg.register(t1);
    reg.register(t2);
    expect(reg.getAll().map((t) => t.name)).toEqual(["tool_a", "tool_b"]);
  });

  it("duplicate name overwrites previous registration", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: "dup", description: "first" }));
    reg.register(makeTool({ name: "dup", description: "second" }));
    expect(reg.getAll()).toHaveLength(1);
    expect(reg.getAll()[0].description).toBe("second");
  });

  it("getAll returns empty array when nothing registered", () => {
    expect(new ToolRegistry().getAll()).toEqual([]);
  });

  describe("buildToolSet", () => {
    it("produces entries keyed by tool name", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "alpha" }));
      reg.register(makeTool({ name: "beta" }));
      const ts = reg.buildToolSet(ctx);
      expect(Object.keys(ts)).toEqual(["alpha", "beta"]);
    });

    it("ALLOW_ALL: all registered tools appear, no filtering", () => {
      const reg = new ToolRegistry();
      for (const name of ["sys", "platform", "integration"]) {
        reg.register(makeTool({ name, tier: name as ToolDef["tier"] }));
      }
      expect(Object.keys(reg.buildToolSet(ctx))).toHaveLength(3);
    });

    it("execute receives the RequestContext", async () => {
      const execute = vi.fn(async (_args: unknown, _ctx: RequestContext) => ({
        success: true as const,
        data: "done",
      }));
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "ctx_check", execute }));
      const ts = reg.buildToolSet(ctx);
      await ts.ctx_check.execute?.({}, { messages: [], toolCallId: "tc1" });
      expect(execute).toHaveBeenCalledWith({}, ctx);
    });
  });

  describe("timeout enforcement", () => {
    it("resolves normally when execute completes within timeout", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ execute: async () => ({ success: true, data: "fast" }) }));
      const ts = reg.buildToolSet(ctx);
      const result = await ts.test_tool.execute?.({}, { messages: [], toolCallId: "tc" });
      expect(result).toEqual({ success: true, data: "fast" });
    });

    it("returns internal_error when execute hangs past TOOL_TIMEOUT_MS", async () => {
      vi.useFakeTimers();
      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          execute: () => new Promise(() => {}), // never resolves
        })
      );
      const ts = reg.buildToolSet(ctx);
      const resultPromise = ts.test_tool.execute?.({}, { messages: [], toolCallId: "tc" });
      vi.advanceTimersByTime(TOOL_TIMEOUT_MS);
      const result = await resultPromise;
      expect(result).toEqual({
        success: false,
        error: { code: "internal_error", message: "tool execution timed out" },
      });
      vi.useRealTimers();
    });
  });
});
