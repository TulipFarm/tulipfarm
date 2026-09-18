import { randomBytes, randomUUID } from "node:crypto";
import {
  accountDefinitionForIntegration,
  McpAccountAuthority,
  type McpAccountRepository,
  type McpAccountUseContext,
  mcpServerRevision,
} from "@tulipfarm/integrations";
import type {
  McpAccount,
  McpChatAccountSelection,
  McpExecutionAuthorization,
  McpIntegrationDefinition,
} from "@tulipfarm/schema";
import {
  McpAccountSecrets,
  type SecretDoc,
  type SecretEnvelopeFields,
  type SecretRepo,
  SecretsService,
} from "@tulipfarm/secrets";
import { describe, expect, it, vi } from "vitest";
import { createMcpRuntimeAccounts, type McpRuntimeAccountsDeps } from "./runtime";

class AccountSecretRepo implements SecretRepo {
  readonly rows = new Map<string, SecretDoc>();
  private revision = 0;
  async list() {
    return [...this.rows.values()];
  }
  async findByKey(key: string) {
    return this.rows.get(key) ?? null;
  }
  async upsert(key: string, fields: SecretEnvelopeFields) {
    const at = new Date(++this.revision);
    this.rows.set(key, {
      _id: key,
      key,
      ...fields,
      dekId: fields.dekId ?? null,
      createdAt: at,
      updatedAt: at,
    });
  }
  async delete(key: string) {
    this.rows.delete(key);
  }
  async findRevision(key: string) {
    return this.rows.get(key)?.updatedAt ?? null;
  }
  async listLegacyKeys() {
    return [];
  }
}

const TOKEN = "mcp-test-credential-opaque";
const capability = { kind: "tool" as const, name: "read_file" };
const caller = { principal: { kind: "user", id: "owner" }, conversationId: "chat" };

async function fixture() {
  const integration: McpIntegrationDefinition = {
    server: {
      id: "github",
      label: "GitHub",
      transport: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
      authentication: { type: "token" },
    },
    enabled: true,
    reviewed: {
      tools: [
        {
          name: "read_file",
          inputSchema: { type: "object" },
          digest: "a".repeat(64),
          mutating: false,
          requiresApproval: false,
        },
      ],
      resources: [],
      prompts: [],
    },
  };
  const secretRepo = new AccountSecretRepo();
  const secrets = new McpAccountSecrets(
    new SecretsService(secretRepo, { dekId: randomUUID(), key: randomBytes(32) })
  );
  const account: McpAccount = {
    id: "personal",
    businessId: "business",
    integrationKey: "github",
    definitionDigest: accountDefinitionForIntegration(integration).definitionDigest,
    label: "Personal GitHub",
    owner: { scope: "personal", principalId: "owner" },
    authentication: "token",
    status: "active",
    isDefault: true,
    revision: 1,
    secretBindings: await secrets.write({ accessToken: TOKEN }),
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let selection: McpChatAccountSelection | undefined;
  const accounts: McpAccountRepository = {
    get: async (_businessId, id) => (id === account.id ? structuredClone(account) : undefined),
    list: async () => [structuredClone(account)],
    save: async (next, revision) => {
      if (account.revision !== revision) return false;
      Object.assign(account, structuredClone(next));
      return true;
    },
    setDefault: async () => true,
    grants: async () => [],
    saveGrant: async () => true,
    revokeGrant: async () => {},
    selection: async () => selection,
    saveSelection: async (next, replace = true) => {
      if (selection && !replace) return false;
      selection = structuredClone(next);
      return true;
    },
  };
  const authorization = {
    isActivePrincipal: vi.fn(async () => true),
    isTeamMember: vi.fn(async () => false),
    canManageShared: vi.fn(async () => false),
  };
  const records = new Map<string, McpExecutionAuthorization>();
  const state = { visibility: "private" as "private" | "shared", output: "safe content" };
  const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init?.redirect).toBe("error");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    if (typeof init?.body !== "string") throw new Error("Missing MCP request");
    const request = JSON.parse(init.body);
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fixture", version: "1" },
        capabilities: { tools: {} },
      };
    } else if (request.method === "tools/list") {
      result = { tools: [{ name: "read_file", inputSchema: { type: "object" } }] };
    } else if (request.method === "tools/call") {
      result = { content: [{ type: "text", text: state.output }] };
    } else {
      throw new Error(`Unexpected MCP method: ${request.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  const deps: McpRuntimeAccountsDeps = {
    businessId: "business",
    accounts,
    authorization,
    authority: new McpAccountAuthority(accounts, authorization),
    authorizations: {
      get: async (businessId, id) => {
        const record = records.get(id);
        return record?.businessId === businessId ? structuredClone(record) : undefined;
      },
      save: async (record) => {
        records.set(record.binding.authorizationId, structuredClone(record));
        return true;
      },
    },
    secrets,
    oauth: { refresh: vi.fn(async () => {}) },
    definition: async () => ({
      ...accountDefinitionForIntegration(integration),
      server: integration.server,
    }),
    integration: () => integration,
    context: async (_caller, scope) => ({
      ...scope,
      kind: "chat",
      conversationId: "chat",
      principalId: "owner",
      visibility: state.visibility,
    }),
    guardedFetch: fetch,
    environment: "production",
  };
  const access = createMcpRuntimeAccounts(deps);
  const bind = () =>
    access.bind({
      caller,
      server: integration.server,
      serverRevision: mcpServerRevision(integration),
      capability,
    });
  return { access, deps, bind, account, authorization, integration, records, state, fetch };
}

describe("MCP runtime account bridge", () => {
  it("recovers immutable authority after reconstruction and refuses live revocation", async () => {
    const f = await fixture();
    const binding = await f.bind();
    expect(await f.bind()).toEqual(binding);
    const recovered = createMcpRuntimeAccounts(f.deps);
    await expect(recovered.revalidate(binding, capability)).resolves.toBeUndefined();
    f.account.status = "revoked";
    await expect(recovered.revalidate(binding, capability)).rejects.toMatchObject({
      code: "account_unavailable",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("refuses substituted capabilities, subjects, account revisions and shared output", async () => {
    const f = await fixture();
    const binding = await f.bind();
    for (const changed of [
      { ...binding, subjectId: "other-user" },
      { ...binding, accountRevision: "2" },
      { ...binding, accountId: "other-account" },
    ]) {
      await expect(f.access.revalidate(changed, capability)).rejects.toMatchObject({
        code: "account_binding_changed",
      });
    }
    await expect(
      f.access.revalidate(binding, { kind: "tool", name: "write_file" })
    ).rejects.toMatchObject({ code: "account_binding_changed" });
    f.state.visibility = "shared";
    await expect(f.access.revalidate(binding, capability)).rejects.toMatchObject({
      code: "account_binding_changed",
    });
  });

  it("uses the actual SDK only inside a bounded encrypted credential lease", async () => {
    const f = await fixture();
    const binding = await f.bind();
    const output = await f.access.use(binding, f.integration.server, async (session) => {
      await session.connect();
      const tool = (await session.discover()).tools[0];
      if (!tool) throw new Error("Fixture Tool missing");
      return session.callTool(tool, {});
    });
    expect(output).toMatchObject({ content: [{ type: "text", text: "safe content" }] });
    expect(f.fetch).toHaveBeenCalled();
    expect(JSON.stringify([...f.records.values()])).not.toContain(TOKEN);
  });

  it("rejects provider output that reflects the credential", async () => {
    const f = await fixture();
    const binding = await f.bind();
    f.state.output = TOKEN;
    await expect(
      f.access.use(binding, f.integration.server, async (session) => {
        await session.connect();
        const tool = (await session.discover()).tools[0];
        if (!tool) throw new Error("Fixture Tool missing");
        return session.callTool(tool, {});
      })
    ).rejects.toMatchObject({ name: "SecretLeakError" });
  });

  it("reauthorizes between discovery and dispatch instead of trusting session admission", async () => {
    const f = await fixture();
    const binding = await f.bind();
    await expect(
      f.access.use(binding, f.integration.server, async (session) => {
        await session.connect();
        const tool = (await session.discover()).tools[0];
        if (!tool) throw new Error("Fixture Tool missing");
        f.authorization.isActivePrincipal.mockResolvedValue(false);
        return session.callTool(tool, {});
      })
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(f.fetch.mock.calls.some(([, init]) => String(init?.body).includes('"tools/call"'))).toBe(
      false
    );
  });

  it("does not let direct source reads bypass disabled or mutating capability policy", async () => {
    const f = await fixture();
    const context: McpAccountUseContext = {
      kind: "chat",
      businessId: "business",
      integrationKey: "github",
      definitionDigest: f.account.definitionDigest,
      principalId: "owner",
      conversationId: "chat",
      visibility: "private",
    };
    f.integration.enabled = false;
    await expect(
      f.access.openContext(context, capability, async () => "unexpected")
    ).rejects.toMatchObject({ code: "account_access_denied" });
    f.integration.enabled = true;
    const tool = f.integration.reviewed.tools[0];
    if (!tool) throw new Error("Fixture review missing");
    tool.mutating = true;
    await expect(
      f.access.openContext(context, capability, async () => "unexpected")
    ).rejects.toMatchObject({ code: "account_access_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
