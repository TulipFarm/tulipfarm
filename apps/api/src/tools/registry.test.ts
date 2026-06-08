import { describe, expect, it, vi } from "vitest";
import { BatchCoordinator } from "./batch-executor";
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

  describe("BatchCoordinator integration", () => {
    it("read-only tools via coordinator run concurrently (both start before either ends)", async () => {
      const log: string[] = [];
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          name: "read_a",
          mutating: false,
          execute: async () => {
            log.push("a:start");
            await delay(20);
            log.push("a:end");
            return { success: true as const, data: "a" };
          },
        })
      );
      reg.register(
        makeTool({
          name: "read_b",
          mutating: false,
          execute: async () => {
            log.push("b:start");
            await delay(20);
            log.push("b:end");
            return { success: true as const, data: "b" };
          },
        })
      );

      const coordinator = new BatchCoordinator();
      const ts = reg.buildToolSet(ctx, coordinator);

      // Simulate SDK: all execute() calls made synchronously before any await
      await Promise.all([
        ts.read_a.execute?.({}, { messages: [], toolCallId: "tc1" }),
        ts.read_b.execute?.({}, { messages: [], toolCallId: "tc2" }),
      ]);

      expect(log[0]).toBe("a:start");
      expect(log[1]).toBe("b:start"); // concurrent: b started before a ended
    });

    it("mutating tool via coordinator forces sequential batch", async () => {
      const log: string[] = [];
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          name: "write_x",
          mutating: true,
          execute: async () => {
            log.push("x:start");
            await delay(20);
            log.push("x:end");
            return { success: true as const, data: "x" };
          },
        })
      );
      reg.register(
        makeTool({
          name: "read_y",
          mutating: false,
          execute: async () => {
            log.push("y:start");
            await delay(20);
            log.push("y:end");
            return { success: true as const, data: "y" };
          },
        })
      );

      const coordinator = new BatchCoordinator();
      const ts = reg.buildToolSet(ctx, coordinator);

      await Promise.all([
        ts.write_x.execute?.({}, { messages: [], toolCallId: "tc1" }),
        ts.read_y.execute?.({}, { messages: [], toolCallId: "tc2" }),
      ]);

      expect(log).toEqual(["x:start", "x:end", "y:start", "y:end"]);
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
