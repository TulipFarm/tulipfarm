import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  JSONRPCMessageSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpClient, DEFAULT_MCP_LIMITS, type McpClient } from "./client";
import type { IsolatedMcpStdioBackend, McpClientOptions, McpOperation } from "./types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixtureServer() {
  const server = new Server(
    { name: "fixture", version: "1" },
    {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: JSON.stringify(request.params.arguments) }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ name: "document", uri: "fixture://document" }],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ name: "documents", uriTemplate: "fixture://{id}" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, text: "private document" }],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: "summarize" }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: "user", content: { type: "text", text: "Summarize this document" } }],
  }));
  cleanup.push(() => server.close());
  return server;
}

async function fixture(input: { sse?: boolean; overrides?: Partial<McpClientOptions> } = {}) {
  const server = fixtureServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: !input.sse,
    keepAliveMs: 0,
  });
  await server.connect(transport);
  const fetch = vi.fn((url: string | URL, init?: RequestInit) =>
    transport.handleRequest(new Request(url, init))
  );
  const beforeRequest = vi.fn(async () => {});
  const options: McpClientOptions = {
    identity: {
      serverId: "fixture",
      accountId: "account-a",
      subjectId: "user-a",
      configurationRevision: "rev-1",
    },
    server: {
      id: "fixture",
      label: "Fixture",
      transport: { type: "streamable-http", url: "https://fixture.test/mcp" },
    },
    remote: { fetch },
    beforeRequest,
    ...input.overrides,
  };
  const client = createMcpClient(options);
  cleanup.push(() => client.close());
  return { client, server, fetch, beforeRequest, options };
}

async function tool(client: McpClient) {
  const handle = (await client.discover()).tools[0];
  if (!handle) throw new Error("fixture Tool missing");
  return handle;
}

describe("MCP client", () => {
  it.each([false, true])("uses the real SDK over Streamable HTTP (SSE=%s)", async (sse) => {
    const { client, beforeRequest } = await fixture({ sse });
    expect(await client.connect()).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: true, resources: true, prompts: true },
    });
    const discovered = await client.discover();
    const firstTool = discovered.tools[0];
    const firstPrompt = discovered.prompts[0];
    if (!firstTool || !firstPrompt) throw new Error("fixture discovery missing");
    expect(firstTool.annotations).toEqual({ readOnlyHint: true });
    expect(await client.callTool(firstTool, { greeting: "hello" })).toMatchObject({
      content: [{ type: "text", text: '{"greeting":"hello"}' }],
    });
    expect(await client.readResource(client.resource("fixture://document"))).toEqual({
      contents: [{ uri: "fixture://document", text: "private document" }],
    });
    expect(await client.getPrompt(firstPrompt)).toMatchObject({
      messages: [{ role: "user", content: { text: "Summarize this document" } }],
    });
    expect(beforeRequest).toHaveBeenCalledWith(client.identity, {
      type: "readResource",
      uri: "fixture://document",
    });
  });

  it("requires host admission even for public unauthenticated servers", async () => {
    const f = await fixture({
      overrides: {
        identity: {
          serverId: "fixture",
          accountId: null,
          subjectId: "user-a",
          configurationRevision: "rev-1",
        },
        beforeRequest: async () => {
          throw new Error("not approved");
        },
      },
    });
    await expect(f.client.connect()).rejects.toMatchObject({ code: "access_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("binds handles to a single client and freezes identity and metadata", async () => {
    const a = await fixture();
    const b = await fixture();
    await a.client.connect();
    await b.client.connect();
    const handle = await tool(a.client);
    expect(Object.isFrozen(handle.inputSchema)).toBe(true);
    expect(Object.isFrozen(handle.identity)).toBe(true);
    await expect(b.client.callTool(handle, {})).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    await expect(a.client.callTool({ ...handle }, {})).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });

  it("uses explicit headers, never follows redirects or inherits cookies", async () => {
    const f = await fixture();
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit");
      expect(init).toMatchObject({ redirect: "manual", credentials: "omit" });
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    });
    const client = createMcpClient({
      ...f.options,
      remote: { fetch, headers: async () => ({ Authorization: "Bearer explicit" }) },
    });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: "access_denied" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a safe authentication failure without retrying or leaking response text", async () => {
    const f = await fixture();
    const fetch = vi.fn(async () => new Response("SECRET TOKEN", { status: 401 }));
    const client = createMcpClient({ ...f.options, remote: { fetch } });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({
      code: "authentication_required",
      message: "MCP authentication required",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("paginates and rejects cursor loops instead of claiming complete discovery", async () => {
    const f = await fixture();
    const list = vi.fn(async (request: { params?: { cursor?: string } }) => ({
      tools: [
        {
          name: request.params?.cursor ? "second" : "first",
          inputSchema: { type: "object" as const },
        },
      ],
      nextCursor: "repeat",
    }));
    f.server.setRequestHandler(ListToolsRequestSchema, list);
    await f.client.connect();
    await expect(f.client.discover()).rejects.toMatchObject({ code: "invalid_response" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("enforces aggregate item and page limits", async () => {
    const f = await fixture({ overrides: { limits: { maxItems: 1 } } });
    await f.client.connect();
    await expect(f.client.discover()).rejects.toMatchObject({ code: "discovery_limit" });
    const g = await fixture({ overrides: { limits: { maxPages: 1 } } });
    await g.client.connect();
    await expect(g.client.discover()).rejects.toMatchObject({ code: "discovery_limit" });
    expect(() =>
      createMcpClient({ ...f.options, limits: { maxPages: DEFAULT_MCP_LIMITS.maxPages + 1 } })
    ).toThrow("MCP invalid configuration");
  });

  it("bounds a stalled admission check without sending a request", async () => {
    const f = await fixture({
      overrides: {
        limits: { requestTimeoutMs: 20 },
        beforeRequest: () => new Promise<void>(() => {}),
      },
    });
    await expect(f.client.connect()).rejects.toMatchObject({ code: "timeout", effect: "none" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized responses rather than returning truncated content", async () => {
    const f = await fixture({ overrides: { limits: { maxResponseBytes: 2048 } } });
    f.server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "x".repeat(4096) }],
    }));
    await f.client.connect();
    const handle = await tool(f.client);
    await expect(f.client.callTool(handle, {})).rejects.toMatchObject({
      code: "response_limit",
      effect: "unknown",
    });
  });

  it("does not run task-required Tools through an unsupported synchronous call", async () => {
    const f = await fixture();
    f.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "task-only",
          inputSchema: { type: "object" },
          execution: { taskSupport: "required" },
        },
      ],
    }));
    await f.client.connect();
    await expect(f.client.callTool(await tool(f.client), {})).rejects.toMatchObject({
      code: "unsupported_capability",
      effect: "none",
    });
  });

  it("reauthorizes every call and never treats a read-only annotation as authority", async () => {
    let revoked = false;
    const f = await fixture({
      overrides: {
        beforeRequest: async (_identity, operation) => {
          if (revoked && operation.type !== "connect") throw new Error("revoked");
        },
      },
    });
    await f.client.connect();
    const handle = await tool(f.client);
    const call = vi.fn(async () => ({ content: [{ type: "text", text: "not reached" }] }));
    f.server.setRequestHandler(CallToolRequestSchema, call);
    revoked = true;
    await expect(f.client.callTool(handle, {})).rejects.toMatchObject({
      code: "access_denied",
      effect: "none",
    });
    await expect(
      f.client.readResource(f.client.resource("fixture://document"))
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(call).not.toHaveBeenCalled();
  });

  it("cancels in-flight calls without retrying an uncertain effect", async () => {
    const f = await fixture();
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    f.server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      calls++;
      started();
      await new Promise<void>((resolve) =>
        extra.signal.addEventListener("abort", () => resolve(), { once: true })
      );
      return { content: [] };
    });
    await f.client.connect();
    const handle = await tool(f.client);
    const controller = new AbortController();
    const pending = f.client.callTool(handle, {}, { signal: controller.signal });
    await begun;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
      effect: "unknown",
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it("explicitly rejects unimplemented protocol revisions", async () => {
    const f = await fixture();
    const client = createMcpClient({
      ...f.options,
      remote: {
        fetch: async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2026-07-28",
              capabilities: {},
              serverInfo: { name: "future", version: "1" },
            },
          });
        },
      },
    });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: "unsupported_protocol" });
  });

  it("does not let notifications silently grant newly discovered Tools", async () => {
    const admitted: McpOperation[] = [];
    const f = await fixture({
      overrides: {
        beforeRequest: async (_identity, operation) => {
          admitted.push(operation);
        },
      },
    });
    await f.client.connect();
    const handle = await tool(f.client);
    await f.server.notification({ method: "notifications/tools/list_changed" });
    await f.client.callTool(handle, {});
    expect(admitted.filter((op) => op.type === "callTool")).toHaveLength(1);
  });

  it("uses isolated stdio framing against a real fixture SDK server", async () => {
    const server = fixtureServer();
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const transport: Transport = {
      async start() {
        void (async () => {
          let pending = "";
          for await (const bytes of incoming) {
            pending += bytes.toString();
            let newline = pending.indexOf("\n");
            while (newline !== -1) {
              const message = JSONRPCMessageSchema.parse(JSON.parse(pending.slice(0, newline)));
              pending = pending.slice(newline + 1);
              transport.onmessage?.(message);
              newline = pending.indexOf("\n");
            }
          }
        })();
      },
      async send(message) {
        outgoing.write(`${JSON.stringify(message)}\n`);
      },
      async close() {
        incoming.end();
        outgoing.end();
        transport.onclose?.();
      },
    };
    await server.connect(transport);
    const backend: IsolatedMcpStdioBackend = {
      attestation: () => ({
        isolation: "remote-managed",
        strongIsolation: true,
        developmentOnly: false,
        provider: "fixture-boundary",
      }),
      open: async (input) => {
        expect(input.environment).toEqual({ PROVIDER_TOKEN: "bound-credential" });
        expect(Object.isFrozen(input.environment)).toBe(true);
        return {
          stdout: outgoing,
          write: async (bytes) => {
            incoming.write(bytes);
          },
          close: async () => {
            await transport.close();
          },
        };
      },
    };
    const f = await fixture({
      overrides: {
        server: {
          id: "fixture",
          label: "Fixture",
          transport: {
            type: "stdio",
            image: `fixture@sha256:${"a".repeat(64)}`,
            command: "/mcp",
            args: [],
            allowedEgress: [],
          },
        },
        local: backend,
        localCredentials: {
          environment: async (identity) => {
            expect(identity.accountId).toBe("account-a");
            return { PROVIDER_TOKEN: "bound-credential" };
          },
        },
      },
    });
    await f.client.connect();
    expect(await f.client.callTool(await tool(f.client), { local: true })).toMatchObject({
      content: [{ text: '{"local":true}' }],
    });
  });

  it("refuses local execution when isolation is unavailable or weak", async () => {
    const f = await fixture();
    const server: McpClientOptions["server"] = {
      id: "fixture",
      label: "Fixture",
      transport: {
        type: "stdio",
        image: `fixture@sha256:${"a".repeat(64)}`,
        command: "/mcp",
        args: [],
        allowedEgress: [],
      },
    };
    for (const local of [
      undefined,
      {
        attestation: () => ({
          isolation: "local" as const,
          strongIsolation: false,
          developmentOnly: true,
          provider: "host",
        }),
        open: vi.fn(),
      },
      {
        attestation: () => ({
          isolation: "container" as const,
          strongIsolation: true,
          developmentOnly: false,
          provider: "not-a-production-backend",
        }),
        open: vi.fn(),
      },
    ]) {
      const client = createMcpClient({ ...f.options, server, local });
      cleanup.push(() => client.close());
      await expect(client.connect()).rejects.toMatchObject({ code: "unsupported_backend" });
    }
  });
});
