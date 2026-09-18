import { compileRoutineAuthority } from "@tulipfarm/authz";
import {
  type McpAccountAccess,
  type McpIntegrationDefinition,
  McpIntegrationService,
  type McpSession,
  mcpCapabilityDigest,
  mcpServerRevision,
  mcpToolContract,
} from "@tulipfarm/integrations";
import { McpError, type McpToolHandle } from "@tulipfarm/mcp";
import { KillSwitchDeniedError } from "@tulipfarm/observability";
import type { CommitActor } from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { LiveToolGate, type RequestContext } from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../broker/tool-adapter";
import { McpToolSync } from "./sync";

function setup() {
  const handle: McpToolHandle = {
    kind: "tool",
    name: "create",
    inputSchema: { type: "object", additionalProperties: false },
    identity: {
      serverId: "example",
      accountId: "account-1",
      subjectId: "muskan",
      configurationRevision: "revision",
    },
  };
  let definition: McpIntegrationDefinition = {
    server: {
      id: "example",
      label: "Example",
      transport: { type: "streamable-http", url: "https://mcp.example.com" },
    },
    enabled: true,
    reviewed: {
      tools: [
        {
          name: handle.name,
          inputSchema: { ...handle.inputSchema },
          digest: mcpCapabilityDigest(handle),
          mutating: true,
          requiresApproval: true,
        },
      ],
      resources: [],
      prompts: [],
    },
  };
  const client: McpSession = {
    connect: async () => ({
      protocolVersion: "2025-11-25",
      name: "test",
      version: "1",
      capabilities: { tools: true, resources: false, prompts: false },
    }),
    discover: async () => ({ tools: [handle], resources: [], prompts: [], resourceTemplates: [] }),
    callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "created" }] })),
    readResource: async () => {
      throw new Error("unused");
    },
    getPrompt: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
  const accounts: McpAccountAccess = {
    bind: vi.fn(async (input) => ({
      serverId: input.server.id,
      serverRevision: input.serverRevision,
      accountId: "account-1",
      accountRevision: "1",
      subjectId: input.caller.principal.id,
      authorizationId: "grant-1",
    })),
    revalidate: async () => {},
    use: async (_binding, _server, callback) => callback(client),
  };
  const service = new McpIntegrationService<CommitActor>(
    {
      list: () => [definition],
      get: () => definition,
      put: async (value) => {
        definition = value;
      },
      remove: async () => {},
    },
    accounts,
    { record: async () => {} }
  );
  const registry = new ToolRegistry({ defaultDeny: true });
  const effects = new MemoryEffectStore();
  const mutationGuard = { assertAllowed: vi.fn(async () => {}) };
  const sync = new McpToolSync({
    registry,
    effects,
    service,
    mutationGuard,
    businessId: "business",
    callerForRun: async ({ runId, principal }) => ({ runId, principal, conversationId: "chat-1" }),
  });
  sync.sync();
  const tool = registry.getAll()[0];
  if (!tool) throw new Error("missing fixture Tool");
  const prepare = () =>
    sync.prepare({
      businessId: "business",
      runId: "run-1",
      stateId: "state-1",
      toolCallId: "call-1",
      tool,
      arguments: {},
      subject: { kind: "user", id: "muskan" },
      agent: { name: "assistant" },
    });
  const context = async (): Promise<RequestContext> => {
    const prepared = await prepare();
    if (!prepared) throw new Error("missing prepared intent");
    return {
      userId: "muskan",
      subject: { kind: "user", id: "muskan" },
      runId: "run-1",
      toolCallId: "call-1",
      toolIntent: prepared.intent,
    };
  };
  return { sync, registry, service, tool, client, accounts, mutationGuard, prepare, context };
}

describe("MCP runtime Tool registration", () => {
  it("uses the canonical governed data class through the real default DLP gate", () => {
    const { tool, service } = setup();
    const definition = service.get("example");
    const reviewed = definition.reviewed.tools[0];
    if (!reviewed || !tool.definition) throw new Error("Missing reviewed Tool fixture");
    const contract = mcpToolContract("example", mcpServerRevision(definition), reviewed);
    expect(contract.spec.dataClasses).toEqual(["source_content"]);
    expect(tool.definition.authorization.dataClasses).toEqual(contract.spec.dataClasses);
    const outcome = new LiveToolGate().authorize({
      definition: tool.definition,
      arguments: {},
      businessId: "business",
      runId: "run-1",
      stateId: "state-1",
      authorityLayers: [{ name: "caller", grants: compileRoutineAuthority([contract]) }],
      guardrailRevision: "guard-1",
    });
    expect(["authorized", "awaiting_approval"]).toContain(outcome.outcome);
    expect(tool.requiresApproval).toBe(true);
  });

  it("requires the existing host's immutable preparation and approval declaration", async () => {
    const { tool, client } = setup();
    expect(tool.requiresApproval).toBe(true);
    expect(tool.definition?.retry).toEqual({ maxAttempts: 1, safeToRetry: false });
    await expect(tool.execute({}, { userId: "muskan", runId: "run-1" })).resolves.toMatchObject({
      success: false,
      error: { code: "write_denied" },
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("pins the exact account before approval", async () => {
    const { prepare } = setup();
    await expect(prepare()).resolves.toMatchObject({
      intent: { mcp: { accountId: "account-1", accountRevision: "1", subjectId: "muskan" } },
    });
  });

  it("records one provider effect and replays its immutable output", async () => {
    const { tool, client, context } = setup();
    const bound = await context();
    const first = await tool.execute({}, bound);
    expect(first.success).toBe(true);
    await expect(tool.execute({}, bound)).resolves.toEqual(first);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("uses the broker kill switch before any provider call", async () => {
    const { tool, client, context, mutationGuard } = setup();
    mutationGuard.assertAllowed.mockRejectedValue(
      new KillSwitchDeniedError("stop", "all_mutations", "operator_stop")
    );
    await expect(tool.execute({}, await context())).resolves.toMatchObject({
      success: false,
      error: { code: "write_denied" },
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("never retries an uncertain mutation", async () => {
    const { tool, client, context } = setup();
    vi.mocked(client.callTool).mockRejectedValue(new McpError("transport_failure", "unknown"));
    await expect(tool.execute({}, await context())).resolves.toMatchObject({
      success: false,
      error: { code: "indeterminate" },
    });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("removes dynamic Tools immediately after disablement", async () => {
    const { service, sync, registry } = setup();
    await service.configure(
      "example",
      {
        server: service.get("example").server,
        enabled: false,
      },
      { principalId: "user:muskan", name: "Muskan Vijayvargiya", email: "muskan@example.com" }
    );
    expect(sync.sync()).toBe(0);
    expect(registry.getAll()).toEqual([]);
  });
});
