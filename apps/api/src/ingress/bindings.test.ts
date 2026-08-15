import type { ToolDef } from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import type { ToolRegistry } from "../broker/tool-adapter";
import { declarativeToolName } from "../tools/declarative/tools";
import { executeToolBinding, extractFromToolResult, INGRESS_ACTOR } from "./bindings";

function makeRegistry(tools: Partial<ToolDef>[]): ToolRegistry {
  return { getAll: () => tools as ToolDef[] } as unknown as ToolRegistry;
}

const RUN = { runId: "run-1", toolCallId: "call-1" };

describe("executeToolBinding", () => {
  it("resolves the slug-namespaced tool and passes templated args", async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: { ok: 1 } }));
    const registry = makeRegistry([
      { name: declarativeToolName("chatapp", "send_message"), tier: "integration", execute },
      { name: declarativeToolName("other", "send_message"), tier: "integration", execute: vi.fn() },
    ]);
    const result = await executeToolBinding(
      registry,
      "chatapp",
      { tool: "send_message", args: { channel_id: "{channel}", text: "{text}" } },
      { channel: "C1", text: "hello" },
      RUN
    );
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      { channel_id: "C1", text: "hello" },
      { userId: INGRESS_ACTOR, autonomy: "full", ...RUN }
    );
  });

  it("cannot bind another integration's tools (slug scoping)", async () => {
    const registry = makeRegistry([
      { name: declarativeToolName("other", "send_message"), tier: "integration", execute: vi.fn() },
    ]);
    const result = await executeToolBinding(
      registry,
      "chatapp",
      { tool: "send_message", args: {} },
      {},
      RUN
    );
    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("errs when the tool is not registered (integration disconnected)", async () => {
    const result = await executeToolBinding(
      makeRegistry([]),
      "chatapp",
      { tool: "send_message", args: {} },
      {},
      RUN
    );
    expect(result.success).toBe(false);
  });
});

describe("extractFromToolResult", () => {
  it("reads a direct dot-path off structured data", () => {
    expect(extractFromToolResult({ profile: { email: "a@b.c" } }, "profile.email")).toBe("a@b.c");
  });

  it("reads from an MCP structuredContent envelope", () => {
    const data = { content: [], structuredContent: { profile: { email: "a@b.c" } } };
    expect(extractFromToolResult(data, "profile.email")).toBe("a@b.c");
  });

  it("parses MCP text content blocks as JSON, skipping non-JSON blocks", () => {
    const data = {
      content: [
        { type: "text", text: "not json" },
        { type: "text", text: '{"profile":{"email":"a@b.c"}}' },
      ],
    };
    expect(extractFromToolResult(data, "profile.email")).toBe("a@b.c");
  });

  it("returns undefined when nothing matches", () => {
    expect(extractFromToolResult({ content: [] }, "profile.email")).toBeUndefined();
    expect(extractFromToolResult(undefined, "a.b")).toBeUndefined();
  });
});
