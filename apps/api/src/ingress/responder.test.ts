import { describe, expect, it, vi } from "vitest";
import type { ToolRegistry } from "../tools/registry";
import type { ToolDef } from "../tools/types";
import { postSlackReply, type SlackResponderDeps } from "./responder";
import type { SlackClient } from "./slack-client";

const log = { warn: vi.fn(), error: vi.fn() };

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "integration_slack_slack_post_message",
    tier: "integration",
    mutating: true,
    description: "post",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        text: { type: "string" },
        thread_ts: { type: "string" },
      },
    },
    execute: vi.fn(async () => ({ success: true as const, data: {} })),
    ...overrides,
  } as ToolDef;
}

function makeDeps(
  tools: ToolDef[],
  postMessage = vi.fn(async () => {})
): SlackResponderDeps & {
  postMessage: ReturnType<typeof vi.fn>;
} {
  return {
    toolRegistry: { getAll: () => tools } as unknown as ToolRegistry,
    client: { postMessage } as unknown as SlackClient,
    log: log as unknown as SlackResponderDeps["log"],
    postMessage,
  };
}

describe("postSlackReply", () => {
  it("prefers the installed MCP slack send tool with schema-mapped args", async () => {
    const tool = makeTool();
    const deps = makeDeps([tool]);
    await postSlackReply(deps, { channel: "C1", text: "hello", threadTs: "100.1" });
    expect(tool.execute).toHaveBeenCalledWith(
      { channel_id: "C1", text: "hello", thread_ts: "100.1" },
      expect.objectContaining({ userId: "integration-ingress" })
    );
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it("omits thread_ts for DM replies", async () => {
    const tool = makeTool();
    const deps = makeDeps([tool]);
    await postSlackReply(deps, { channel: "D1", text: "hi" });
    expect(tool.execute).toHaveBeenCalledWith({ channel_id: "D1", text: "hi" }, expect.anything());
  });

  it("falls back to direct postMessage when the tool fails", async () => {
    const tool = makeTool({
      execute: vi.fn(async () => ({
        success: false as const,
        error: { code: "internal_error" as const, message: "boom" },
      })),
    });
    const deps = makeDeps([tool]);
    await postSlackReply(deps, { channel: "C1", text: "hello", threadTs: "1.1" });
    expect(deps.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "hello",
      threadTs: "1.1",
    });
  });

  it("falls back when the tool schema cannot thread but the reply needs a thread", async () => {
    const tool = makeTool({
      inputSchema: {
        type: "object",
        properties: { channel: { type: "string" }, text: { type: "string" } },
      },
    });
    const deps = makeDeps([tool]);
    await postSlackReply(deps, { channel: "C1", text: "x", threadTs: "1.1" });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(deps.postMessage).toHaveBeenCalled();
  });

  it("uses direct postMessage when no slack tool is installed, and never throws", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const deps = makeDeps([], failing);
    await expect(postSlackReply(deps, { channel: "C1", text: "x" })).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it("ignores non-integration or non-slack tools", async () => {
    const wrongTier = makeTool({ name: "slack_send", tier: "platform" });
    const wrongName = makeTool({ name: "integration_github_create_issue" });
    const deps = makeDeps([wrongTier, wrongName]);
    await postSlackReply(deps, { channel: "C1", text: "x" });
    expect(wrongTier.execute).not.toHaveBeenCalled();
    expect(wrongName.execute).not.toHaveBeenCalled();
    expect(deps.postMessage).toHaveBeenCalled();
  });
});
