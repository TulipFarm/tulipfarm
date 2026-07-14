import { describe, expect, it, vi } from "vitest";
import type { ToolRegistry } from "../tools/registry";
import type { ToolDef } from "../tools/types";
import { postReply } from "./responder";

const REPLY = {
  default: { tool: "send_message", args: { channel_id: "{channel}", text: "{text}" } },
  thread: {
    tool: "reply_in_thread",
    args: { channel_id: "{channel}", thread_ts: "{thread}", text: "{text}" },
  },
};

function makeRegistry(tools: Record<string, ToolDef["execute"]>): ToolRegistry {
  return {
    getAll: () =>
      Object.entries(tools).map(
        ([name, execute]) =>
          ({ name: `integration_chatapp_${name}`, tier: "integration", execute }) as ToolDef
      ),
  } as unknown as ToolRegistry;
}

function makeLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("postReply", () => {
  it("executes the named binding with decision vars + injected {text}", async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: {} }));
    const log = makeLog();
    await postReply(
      { registry: makeRegistry({ reply_in_thread: execute }), log },
      {
        slug: "chatapp",
        reply: REPLY,
        binding: "thread",
        vars: { channel: "C1", thread: "1.1" },
        text: "the answer",
      }
    );
    expect(execute).toHaveBeenCalledWith(
      { channel_id: "C1", thread_ts: "1.1", text: "the answer" },
      expect.anything()
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("falls back to the `default` binding when the named one is not declared", async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: {} }));
    await postReply(
      { registry: makeRegistry({ send_message: execute }), log: makeLog() },
      { slug: "chatapp", reply: REPLY, binding: "nonexistent", vars: { channel: "C1" }, text: "t" }
    );
    expect(execute).toHaveBeenCalledWith({ channel_id: "C1", text: "t" }, expect.anything());
  });

  it("logs and drops when the manifest declares no usable binding", async () => {
    const log = makeLog();
    await postReply(
      { registry: makeRegistry({}), log },
      { slug: "chatapp", reply: {}, binding: "thread", vars: {}, text: "t" }
    );
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("dropped"));
  });

  it("never throws: tool failure and tool throw both only log", async () => {
    const log = makeLog();
    await postReply(
      {
        registry: makeRegistry({
          send_message: async () => ({
            success: false as const,
            error: { code: "internal_error" as const, message: "nope" },
          }),
        }),
        log,
      },
      { slug: "chatapp", reply: REPLY, binding: "default", vars: { channel: "C1" }, text: "t" }
    );
    expect(log.error).toHaveBeenCalledTimes(1);

    await expect(
      postReply(
        {
          registry: makeRegistry({
            send_message: async () => {
              throw new Error("boom");
            },
          }),
          log,
        },
        { slug: "chatapp", reply: REPLY, binding: "default", vars: { channel: "C1" }, text: "t" }
      )
    ).resolves.toBeUndefined();
  });

  it("logs and drops when no registry is available", async () => {
    const log = makeLog();
    await postReply(
      { registry: undefined, log },
      { slug: "chatapp", reply: REPLY, binding: "default", vars: {}, text: "t" }
    );
    expect(log.error).toHaveBeenCalled();
  });
});
