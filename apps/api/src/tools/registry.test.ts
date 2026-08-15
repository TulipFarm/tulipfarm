import type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequestInfo,
  RequestContext,
  ToolCallResult,
  ToolDef,
} from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PRESENTATION_CORRECTIVE_ATTEMPTS,
  type RunToolCallGuard,
  TOOL_TIMEOUT_MS,
  ToolRegistry,
} from "../broker/tool-adapter";
import { BatchCoordinator } from "./batch-executor";

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

  it("duplicate name is refused instead of silently overwriting", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: "dup", description: "first" }));
    expect(() => reg.register(makeTool({ name: "dup", description: "second" }))).toThrow(
      'Tool "dup" is already registered'
    );
    expect(reg.getAll()).toHaveLength(1);
    expect(reg.getAll()[0]?.description).toBe("first");
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
      await ts.ctx_check.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" });
      expect(execute).toHaveBeenCalledWith({}, ctx);
    });

    it("allowedToolNames scopes the set to the per-agent allowlist", () => {
      const reg = new ToolRegistry();
      for (const name of ["read_a", "create_resource_type", "write_b"]) {
        reg.register(makeTool({ name }));
      }
      const ts = reg.buildToolSet(
        ctx,
        undefined,
        undefined,
        undefined,
        undefined,
        new Set(["read_a"])
      );
      expect(Object.keys(ts)).toEqual(["read_a"]);
    });

    it("allowedToolNames undefined keeps the default ALLOW_ALL behavior", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "alpha" }));
      reg.register(makeTool({ name: "beta" }));
      expect(Object.keys(reg.buildToolSet(ctx))).toEqual(["alpha", "beta"]);
    });

    it("defaults to deny when the production adapter requires an explicit allowlist", () => {
      const reg = new ToolRegistry({ defaultDeny: true });
      reg.register(makeTool({ name: "alpha" }));
      expect(reg.buildToolSet(ctx)).toEqual({});
      expect(
        Object.keys(
          reg.buildToolSet(ctx, undefined, undefined, undefined, undefined, new Set(["alpha"]))
        )
      ).toEqual(["alpha"]);
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
        ts.read_a.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" }),
        ts.read_b.execute?.({}, { messages: [], context: undefined, toolCallId: "tc2" }),
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
        ts.write_x.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" }),
        ts.read_y.execute?.({}, { messages: [], context: undefined, toolCallId: "tc2" }),
      ]);

      expect(log).toEqual(["x:start", "x:end", "y:start", "y:end"]);
    });
  });

  describe("validation (TOOL-V1-009)", () => {
    const schemaedTool = (overrides: Partial<ToolDef> = {}): ToolDef =>
      makeTool({
        inputSchema: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
          additionalProperties: false,
        },
        ...overrides,
      });

    it("bad args return validation_error result without calling execute", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "should not reach" }));
      const reg = new ToolRegistry();
      reg.register(schemaedTool({ name: "vt", execute }));
      const ts = reg.buildToolSet(ctx);
      const result = await ts.vt.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc1" }
      );
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
      expect(execute).not.toHaveBeenCalled();
    });

    it("reports all useful argument errors instead of forcing field-by-field corrections", async () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          name: "strict_shape",
          inputSchema: {
            type: "object",
            required: ["name", "version"],
            properties: {
              name: { type: "string" },
              version: { type: "string" },
            },
          },
        })
      );
      const result = await reg
        .buildToolSet(ctx)
        .strict_shape.execute?.({}, { messages: [], context: undefined, toolCallId: "tc-errors" });

      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
      expect(JSON.stringify(result)).toContain("name");
      expect(JSON.stringify(result)).toContain("version");
    });

    it("enforces the presentation correction limit for one Turn", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "presented" }));
      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          name: "present",
          inputSchema: {
            type: "object",
            required: ["component"],
            properties: { component: { type: "object" } },
          },
          execute,
          // The corrective limit applies to Tools that present, and that is now read from the
          // declaration rather than matched by name.
          definition: { availableTo: { requiresPresentation: true } } as ToolDef["definition"],
        })
      );
      const presentationContext: RequestContext = {
        userId: "u1",
        presentationContext: {
          target: { channel: "web", surface: "chat" },
          destination: "conversation:1",
          rendererCapabilities: [],
        },
      };
      const present = reg.buildToolSet(presentationContext).present;
      for (let attempt = 0; attempt <= MAX_PRESENTATION_CORRECTIVE_ATTEMPTS; attempt += 1) {
        const result = await present.execute?.(
          {},
          { messages: [], context: undefined, toolCallId: `tc-present-${attempt}` }
        );
        expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
      }
      const blocked = await present.execute?.(
        { component: {} },
        { messages: [], context: undefined, toolCallId: "tc-present-blocked" }
      );

      expect(blocked).toMatchObject({ success: false, error: { code: "surface_invalid" } });
      expect(JSON.stringify(blocked)).toContain("correction limit");
      expect(execute).not.toHaveBeenCalled();
    });

    it("valid args pass through to execute", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "reached" }));
      const reg = new ToolRegistry();
      reg.register(schemaedTool({ name: "vt2", execute }));
      const ts = reg.buildToolSet(ctx);
      const result = await ts.vt2.execute?.(
        { key: "hello" },
        { messages: [], context: undefined, toolCallId: "tc2" }
      );
      expect(result).toEqual({ success: true, data: "reached" });
      expect(execute).toHaveBeenCalledWith({ key: "hello" }, ctx);
    });

    it("bad args with coordinator return validation_error (no coordinator scheduling)", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "nope" }));
      const reg = new ToolRegistry();
      reg.register(schemaedTool({ name: "vt3", execute }));
      const coordinator = new BatchCoordinator();
      const ts = reg.buildToolSet(ctx, coordinator);
      const result = await ts.vt3.execute?.(
        { wrong: 123 },
        { messages: [], context: undefined, toolCallId: "tc3" }
      );
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("result truncation + cache (TOOL-V1-010)", () => {
    const bigList = Array.from({ length: 25 }, (_, i) => i);

    it("stores full result in cache and returns truncated result to SDK", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ execute: async () => ({ success: true as const, data: bigList }) }));
      const cache = new Map<string, import("@tulipfarm/tool-host").ToolCallResult>();
      const ts = reg.buildToolSet(ctx, undefined, cache);
      const result = await ts.test_tool.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc-full" }
      );
      expect((result as { success: true; data: { total_count: number } }).data.total_count).toBe(
        25
      );
      expect(cache.get("tc-full")).toEqual({ success: true, data: bigList });
    });

    it("without cache: small result passes through unchanged", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ execute: async () => ({ success: true as const, data: [1, 2] }) }));
      const ts = reg.buildToolSet(ctx);
      const result = await ts.test_tool.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc-small" }
      );
      expect(result).toEqual({ success: true, data: [1, 2] });
    });

    it("turns thrown Tool errors into a visible, cached result", async () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          execute: async () => {
            throw new Error("private database detail");
          },
        })
      );
      const cache = new Map<string, ToolCallResult>();
      const result = await reg
        .buildToolSet(ctx, undefined, cache)
        .test_tool.execute?.({}, { messages: [], context: undefined, toolCallId: "tc-thrown" });

      expect(result).toEqual({
        success: false,
        error: {
          code: "internal_error",
          message:
            "The Tool could not be completed because the server encountered an internal error.",
        },
      });
      expect(cache.get("tc-thrown")).toEqual(result);
      expect(JSON.stringify(result)).not.toContain("private database detail");
    });

    it("cache not set when args are invalid (validation_error short-circuits)", async () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          name: "strict",
          inputSchema: {
            type: "object",
            required: ["key"],
            properties: { key: { type: "string" } },
            additionalProperties: false,
          },
        })
      );
      const cache = new Map<string, import("@tulipfarm/tool-host").ToolCallResult>();
      const ts = reg.buildToolSet(ctx, undefined, cache);
      await ts.strict.execute?.({}, { messages: [], context: undefined, toolCallId: "tc-inv" });
      expect(cache.has("tc-inv")).toBe(false);
    });
  });

  describe("timeout enforcement", () => {
    it("resolves normally when execute completes within timeout", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ execute: async () => ({ success: true, data: "fast" }) }));
      const ts = reg.buildToolSet(ctx);
      const result = await ts.test_tool.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc" }
      );
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
      const resultPromise = ts.test_tool.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc" }
      );
      vi.advanceTimersByTime(TOOL_TIMEOUT_MS);
      const result = await resultPromise;
      expect(result).toEqual({
        success: false,
        error: { code: "internal_error", message: "tool execution timed out" },
      });
      vi.useRealTimers();
    });
  });

  describe("approval gate (mode-gated mutating tools)", () => {
    function controllableGate(): {
      gate: ApprovalGate;
      calls: ApprovalRequestInfo[];
      resolve: (d: ApprovalDecision) => void;
    } {
      const calls: ApprovalRequestInfo[] = [];
      let resolveFn!: (d: ApprovalDecision) => void;
      const gate: ApprovalGate = {
        request: (info) => {
          calls.push(info);
          return new Promise<ApprovalDecision>((r) => {
            resolveFn = r;
          });
        },
      };
      return { gate, calls, resolve: (d) => resolveFn(d) };
    }

    const approvalCtx: RequestContext = { ...ctx, autonomy: "approval-required" };

    it("approval-required + mutating: suspends until approved, then runs the tool", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "ran" }));
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "write_x", mutating: true, execute }));
      const { gate, calls, resolve } = controllableGate();
      const ts = reg.buildToolSet(approvalCtx, undefined, undefined, gate);

      const p = ts.write_x.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" });
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ toolCallId: "tc1", toolName: "write_x" });
      expect(execute).not.toHaveBeenCalled();

      resolve({ outcome: "approved" });
      expect(await p).toEqual({ success: true, data: "ran" });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("approval-required + mutating: deny returns internal_error, never runs the tool, caches denial", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "ran" }));
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "write_x", mutating: true, execute }));
      const { gate, resolve } = controllableGate();
      const cache = new Map<string, import("@tulipfarm/tool-host").ToolCallResult>();
      const ts = reg.buildToolSet(approvalCtx, undefined, cache, gate);

      const p = ts.write_x.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" });
      resolve({ outcome: "denied", reason: "denied by operator" });
      const result = await p;

      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: { code: "internal_error", message: "denied by operator" },
      });
      expect(cache.get("tc1")).toMatchObject({ success: false, error: { code: "internal_error" } });
    });

    it("read-only tool under approval-required: no gate, runs directly", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "read" }));
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "read_x", mutating: false, execute }));
      const { gate, calls } = controllableGate();
      const ts = reg.buildToolSet(approvalCtx, undefined, undefined, gate);

      expect(
        await ts.read_x.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" })
      ).toEqual({
        success: true,
        data: "read",
      });
      expect(calls).toHaveLength(0);
    });

    it("mutating tool but autonomy=full: no gate, runs directly", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "ran" }));
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "write_x", mutating: true, execute }));
      const { gate, calls } = controllableGate();
      const ts = reg.buildToolSet({ ...ctx, autonomy: "full" }, undefined, undefined, gate);

      await ts.write_x.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" });
      expect(calls).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("no gate wired: approval-required + mutating still runs (gate optional)", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "write_x", mutating: true }));
      const ts = reg.buildToolSet(approvalCtx);
      expect(
        await ts.write_x.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" })
      ).toEqual({
        success: true,
        data: "ok",
      });
    });

    it("soul mutation (requiresApproval:false) under approval-required: no gate, runs directly", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "soul-ran" }));
      const reg = new ToolRegistry();
      reg.register(
        makeTool({ name: "agent_create", mutating: true, requiresApproval: false, execute })
      );
      const { gate, calls } = controllableGate();
      const ts = reg.buildToolSet(approvalCtx, undefined, undefined, gate);

      expect(
        await ts.agent_create.execute?.(
          {},
          { messages: [], context: undefined, toolCallId: "tc-soul" }
        )
      ).toEqual({
        success: true,
        data: "soul-ran",
      });
      expect(calls).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("the approval wait is NOT subject to the 30s tool timeout (gate is outside withToolTimeout)", async () => {
      vi.useFakeTimers();
      try {
        const execute = vi.fn(async () => ({ success: true as const, data: "ran" }));
        const reg = new ToolRegistry();
        reg.register(makeTool({ name: "write_x", mutating: true, execute }));
        const { gate, resolve } = controllableGate();
        const ts = reg.buildToolSet(approvalCtx, new BatchCoordinator(), undefined, gate);

        const p = ts.write_x.execute?.({}, { messages: [], context: undefined, toolCallId: "tc1" });
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS * 3);
        expect(execute).not.toHaveBeenCalled(); // still pending, not timed out

        resolve({ outcome: "approved" });
        expect(await p).toEqual({ success: true, data: "ran" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("tool-call guard (denial path)", () => {
    it("blocked guard returns denial result, caches it, never runs the tool", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "should not reach" }));
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "guarded", execute }));
      const guard = vi.fn<RunToolCallGuard>(async () => ({ blocked: true, reason: "x" }));
      const cache = new Map<string, import("@tulipfarm/tool-host").ToolCallResult>();
      const ts = reg.buildToolSet(ctx, undefined, cache, undefined, guard);

      const result = await ts.guarded.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc1" }
      );

      expect(result).toMatchObject({
        success: false,
        error: { code: "internal_error", message: "blocked by guardrail: x" },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(cache.get("tc1")).toMatchObject({
        success: false,
        error: { code: "internal_error", message: "blocked by guardrail: x" },
      });
    });

    // A tool whose schema accepts a `key` string — lets us exercise arg transform/forwarding
    // without tripping the (correct) pre-guard arg-validation on the default empty schema.
    const keyTool = (overrides: Partial<ToolDef> = {}): ToolDef =>
      makeTool({
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          additionalProperties: false,
        },
        ...overrides,
      });

    it("guard receives the tool, args, ctx, and toolCallId", async () => {
      const reg = new ToolRegistry();
      reg.register(keyTool({ name: "inspected" }));
      const guard = vi.fn<RunToolCallGuard>(async () => ({ blocked: false, args: { key: "a" } }));
      const ts = reg.buildToolSet(ctx, undefined, undefined, undefined, guard);

      await ts.inspected.execute?.(
        { key: "a" },
        { messages: [], context: undefined, toolCallId: "tc-i" }
      );

      expect(guard).toHaveBeenCalledWith({
        tool: expect.objectContaining({ name: "inspected" }),
        args: { key: "a" },
        ctx,
        toolCallId: "tc-i",
      });
    });

    it("not-blocked guard runs the tool with the (possibly transformed) args", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "ran" }));
      const reg = new ToolRegistry();
      reg.register(keyTool({ name: "passing", execute }));
      const guard = vi.fn<RunToolCallGuard>(async () => ({
        blocked: false,
        args: { key: "swapped" },
      }));
      const ts = reg.buildToolSet(ctx, undefined, undefined, undefined, guard);

      const result = await ts.passing.execute?.(
        { key: "original" },
        {
          messages: [],
          context: undefined,
          toolCallId: "tc2",
        }
      );

      expect(result).toEqual({ success: true, data: "ran" });
      // effectiveArgs (the guard's returned args) are forwarded to the tool, not the originals.
      expect(execute).toHaveBeenCalledWith({ key: "swapped" }, ctx);
    });

    it("no guard passed: tool executes unchanged", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "direct" }));
      const reg = new ToolRegistry();
      reg.register(keyTool({ name: "unguarded", execute }));
      const ts = reg.buildToolSet(ctx);

      const result = await ts.unguarded.execute?.(
        { key: "v" },
        { messages: [], context: undefined, toolCallId: "tc3" }
      );

      expect(result).toEqual({ success: true, data: "direct" });
      expect(execute).toHaveBeenCalledWith({ key: "v" }, ctx);
    });

    it("blocked guard runs AFTER arg-validation (invalid args short-circuit before the guard)", async () => {
      const guard = vi.fn<RunToolCallGuard>(async () => ({ blocked: true, reason: "x" }));
      const reg = new ToolRegistry();
      reg.register(
        makeTool({
          name: "strict_guarded",
          inputSchema: {
            type: "object",
            required: ["key"],
            properties: { key: { type: "string" } },
            additionalProperties: false,
          },
        })
      );
      const ts = reg.buildToolSet(ctx, undefined, undefined, undefined, guard);

      const result = await ts.strict_guarded.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc4" }
      );

      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
      expect(guard).not.toHaveBeenCalled();
    });

    it("blocked guard works through the coordinator branch too (denial, tool not scheduled)", async () => {
      const execute = vi.fn(async () => ({ success: true as const, data: "nope" }));
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "coord_guarded", mutating: true, execute }));
      const guard = vi.fn<RunToolCallGuard>(async () => ({ blocked: true, reason: "blocklist" }));
      const ts = reg.buildToolSet(ctx, new BatchCoordinator(), undefined, undefined, guard);

      const result = await ts.coord_guarded.execute?.(
        {},
        { messages: [], context: undefined, toolCallId: "tc5" }
      );

      expect(result).toMatchObject({
        success: false,
        error: { code: "internal_error", message: "blocked by guardrail: blocklist" },
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
