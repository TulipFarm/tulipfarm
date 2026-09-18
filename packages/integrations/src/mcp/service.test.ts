import type { McpDiscovery, McpToolHandle } from "@tulipfarm/mcp";
import { describe, expect, it, vi } from "vitest";
import { emptyMcpReview, type McpIntegrationDefinition } from "./definition";
import { McpIntegrationError } from "./errors";
import type {
  McpAccountAccess,
  McpCaller,
  McpDefinitionStore,
  McpExecutionBinding,
  McpSession,
} from "./ports";
import { McpIntegrationService, mcpCapabilityDigest } from "./service";

const caller: McpCaller = { principal: { kind: "user", id: "muskan" } };

function setup() {
  const tool: McpToolHandle = {
    name: "search",
    kind: "tool",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
    identity: {
      serverId: "example",
      accountId: "personal-account",
      subjectId: "muskan",
      configurationRevision: "revision",
    },
  };
  const discovery: McpDiscovery = {
    tools: [tool],
    resources: [
      {
        kind: "resource",
        uri: "docs://welcome",
        name: "Welcome",
        identity: tool.identity,
      },
    ],
    prompts: [{ kind: "prompt", name: "summarize", identity: tool.identity }],
    resourceTemplates: [],
  };
  let current: McpIntegrationDefinition = {
    server: {
      id: "example",
      label: "Example",
      transport: { type: "streamable-http", url: "https://mcp.example.com" },
    },
    enabled: true,
    reviewed: emptyMcpReview(),
  };
  const store: McpDefinitionStore<string> = {
    list: () => [current],
    get: (id) => (id === current.server.id ? current : undefined),
    put: vi.fn(async (definition) => {
      current = definition;
    }),
    remove: vi.fn(async () => {}),
  };
  const client: McpSession = {
    connect: vi.fn(async () => ({
      protocolVersion: "2025-11-25",
      name: "example",
      version: "1",
      capabilities: { tools: true, resources: true, prompts: true },
    })),
    discover: vi.fn(async () => discovery),
    callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "result" }] })),
    readResource: vi.fn(async () => ({ contents: [{ uri: "docs://welcome", text: "Welcome" }] })),
    getPrompt: vi.fn(async () => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: "Summarize this." } },
      ],
    })),
    close: vi.fn(async () => {}),
  };
  const accounts: McpAccountAccess = {
    bind: vi.fn(
      async (input): Promise<McpExecutionBinding> => ({
        serverId: input.server.id,
        serverRevision: input.serverRevision,
        accountId: "personal-account",
        accountRevision: "credential-1",
        subjectId: input.caller.principal.id,
        authorizationId: "authorization-1",
      })
    ),
    revalidate: vi.fn(async () => {}),
    use: async (_binding, _server, callback) => callback(client),
  };
  const audit = { record: vi.fn(async () => {}) };
  const service = new McpIntegrationService(store, accounts, audit);
  return { service, store, client, tool, discovery, accounts, audit };
}

describe("MCP Integration service", () => {
  it.each(["github", "slack"])(
    "rejects reserved Integration slug %s before persistence",
    async (id) => {
      const { service, store, accounts } = setup();
      const original = service.get("example");
      await expect(
        service.configure(
          id,
          {
            server: { ...original.server, id },
            enabled: true,
          },
          "actor"
        )
      ).rejects.toMatchObject({
        code: "invalid_definition",
        message: "The Integration slug is reserved for a native channel.",
      });
      expect(store.put).not.toHaveBeenCalled();
      expect(accounts.bind).not.toHaveBeenCalled();
      expect(service.get("example")).toEqual(original);
    }
  );

  it("does not enable discovered capabilities or trust read-only hints", async () => {
    const { service } = setup();
    const review = await service.discover("example", caller);
    expect(review.tools[0]).toMatchObject({ mutating: true, requiresApproval: true });
    expect(service.get("example").reviewed.tools).toEqual([]);
    await expect(service.readResource("example", caller, "docs://welcome")).rejects.toMatchObject({
      code: "review_required",
    });
  });

  it("persists only the exact reviewed discovery and refuses changed metadata", async () => {
    const { service, store } = setup();
    const review = await service.discover("example", caller);
    const first = review.tools[0];
    if (!first) throw new Error("missing fixture Tool");
    first.inputSchema = { type: "object", additionalProperties: true };
    await expect(service.review("example", review, caller, "actor")).rejects.toMatchObject({
      code: "capability_changed",
    });
    expect(store.put).not.toHaveBeenCalled();
  });

  it("reads resources and renders prompts only after explicit review", async () => {
    const { service, client } = setup();
    const review = await service.discover("example", caller);
    await service.review("example", review, caller, "actor");
    await expect(service.readResource("example", caller, "docs://welcome")).resolves.toEqual({
      contents: [{ uri: "docs://welcome", text: "Welcome" }],
    });
    await expect(service.renderPrompt("example", caller, "summarize", {})).resolves.toMatchObject({
      messages: [{ role: "user" }],
    });
    expect(client.close).toHaveBeenCalledTimes(4);
  });

  it("refuses changed capabilities before calling the provider", async () => {
    const { service, client, tool } = setup();
    await service.review("example", await service.discover("example", caller), caller, "actor");
    const binding = await service.bind("example", caller, { kind: "tool", name: "search" });
    vi.mocked(client.discover).mockResolvedValue({
      tools: [
        { ...tool, inputSchema: { type: "object", properties: { account: { type: "string" } } } },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });
    await expect(service.callTool(binding, caller, "search", {})).rejects.toMatchObject({
      code: "capability_changed",
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("never changes an approved account to keep a call running", async () => {
    const { service, accounts, client } = setup();
    await service.review("example", await service.discover("example", caller), caller, "actor");
    const binding = await service.bind("example", caller, { kind: "tool", name: "search" });
    vi.mocked(accounts.bind).mockResolvedValue({ ...binding, accountId: "another-account" });
    await expect(service.callTool(binding, caller, "search", {})).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("rechecks account access after discovery and before resource disclosure", async () => {
    const { service, accounts, client, audit } = setup();
    await service.review("example", await service.discover("example", caller), caller, "actor");
    vi.mocked(accounts.revalidate)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new McpIntegrationError("forbidden", "Account grant was revoked."));
    await expect(service.readResource("example", caller, "docs://welcome")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(client.readResource).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "refused",
        code: "forbidden",
      })
    );
  });

  it("clears reviewed capabilities when transport changes", async () => {
    const { service } = setup();
    await service.review("example", await service.discover("example", caller), caller, "actor");
    await service.configure(
      "example",
      {
        server: {
          id: "example",
          label: "Example",
          transport: { type: "streamable-http", url: "https://other.example.com/mcp" },
        },
        enabled: true,
      },
      "actor"
    );
    expect(service.get("example").reviewed).toEqual(emptyMcpReview());
  });

  it("excludes account identity from capability review digests", () => {
    const { tool } = setup();
    expect(mcpCapabilityDigest(tool)).toBe(
      mcpCapabilityDigest({
        ...tool,
        identity: { ...tool.identity, accountId: "other-personal-account" },
      })
    );
  });
});
