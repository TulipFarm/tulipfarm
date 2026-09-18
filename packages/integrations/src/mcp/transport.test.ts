import { type Agent, Response as UndiciResponse, type fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import { createMcpGuardedFetch } from "./transport";

const { created, destroyed } = vi.hoisted(() => ({
  created: vi.fn<(options: Agent.Options) => void>(),
  destroyed: vi.fn(async () => {}),
}));
vi.mock("undici", async (original) => {
  const actual = await original<typeof import("undici")>();
  return {
    ...actual,
    Agent: class {
      constructor(options: Agent.Options) {
        created(options);
      }
      destroy = destroyed;
    },
  };
});

describe("MCP guarded streaming fetch", () => {
  it("pins public DNS answers and delivers SSE before the server closes its stream", async () => {
    const cancelled = vi.fn();
    const fetch = vi.fn<typeof undiciFetch>().mockResolvedValue(
      new UndiciResponse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    const guarded = createMcpGuardedFetch({
      resolve: async () => ["8.8.8.8"],
      fetch,
    });
    const response = await guarded("https://mcp.example.com/rpc", {
      method: "POST",
      headers: { authorization: "Bearer scoped" },
      body: "{}",
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const connect = created.mock.lastCall?.[0].connect;
    if (
      !connect ||
      typeof connect === "function" ||
      !("lookup" in connect) ||
      typeof connect.lookup !== "function"
    )
      throw new Error("Missing DNS pin");
    const lookedUp = vi.fn();
    connect.lookup("mcp.example.com", { all: true }, lookedUp);
    expect(lookedUp).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: hello\n\n");
    await reader?.cancel();
    expect(cancelled).toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://mcp.example.com/rpc",
      expect.objectContaining({
        redirect: "manual",
        body: "{}",
        headers: { authorization: "Bearer scoped" },
      })
    );
  });

  it("rejects mixed public/private DNS answers before sending credentials", async () => {
    const fetch = vi.fn<typeof undiciFetch>();
    const guarded = createMcpGuardedFetch({
      resolve: async () => ["8.8.8.8", "127.0.0.1"],
      fetch,
    });
    await expect(guarded("https://mcp.example.com")).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not follow credential-bearing redirects", async () => {
    const fetch = vi.fn<typeof undiciFetch>().mockResolvedValue(
      new UndiciResponse(null, {
        status: 307,
        headers: { location: "https://other.example.com" },
      })
    );
    const guarded = createMcpGuardedFetch({ resolve: async () => ["8.8.8.8"], fetch });
    await expect(guarded("https://mcp.example.com")).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds streamed response bytes", async () => {
    const fetch = vi
      .fn<typeof undiciFetch>()
      .mockResolvedValue(new UndiciResponse(new Uint8Array(8 * 1024 * 1024 + 1)));
    const guarded = createMcpGuardedFetch({ resolve: async () => ["8.8.8.8"], fetch });
    const response = await guarded("https://mcp.example.com");
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "response_limit" });
  });
});
