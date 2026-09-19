import { MCP_CATALOG, type McpDiscovery, McpError, type McpToolHandle } from "@tulipfarm/mcp";
import type {
  McpAccount,
  McpAccountGrant,
  McpChatAccountSelection,
  McpIntegrationDefinition,
  McpSetupOperation,
  McpSetupStart,
} from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import type { McpDefinitionStore, McpSession } from "../mcp/ports";
import { McpIntegrationService, mcpServerRevision } from "../mcp/service";
import { McpAccountAuthority, type McpAccountRepository } from "./authority";
import { accountDefinitionForIntegration } from "./definition";
import { McpAccountLifecycle } from "./lifecycle";
import { type McpSetupRepository, McpSetupService } from "./setup";

class Operations implements McpSetupRepository {
  rows = new Map<string, McpSetupOperation>();
  leases = new Map<string, string>();
  async get(_business: string, id: string) {
    const row = this.rows.get(id);
    return row && structuredClone(row);
  }
  async list(_business: string, principal: string, integrationKey: string, accountId: string) {
    return [...this.rows.values()]
      .filter(
        (op) =>
          op.principalId === principal &&
          op.integrationKey === integrationKey &&
          op.accountId === accountId
      )
      .map((op) => structuredClone(op));
  }
  async insert(op: McpSetupOperation) {
    if (!this.rows.has(op.id)) this.rows.set(op.id, structuredClone(op));
  }
  async claim(_business: string, id: string, lease: string) {
    if (this.leases.has(id)) return false;
    this.leases.set(id, lease);
    return true;
  }
  async save(op: McpSetupOperation, lease: string) {
    if (this.leases.get(op.id) !== lease) throw new Error("Lost lease");
    this.rows.set(op.id, structuredClone(op));
  }
  async release(_business: string, id: string, lease: string) {
    if (this.leases.get(id) === lease) this.leases.delete(id);
  }
}
class Accounts implements McpAccountRepository {
  rows = new Map<string, McpAccount>();
  async get(_business: string, id: string) {
    const row = this.rows.get(id);
    return row && structuredClone(row);
  }
  async list() {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
  async save(account: McpAccount, revision?: number) {
    if (this.rows.get(account.id)?.revision !== revision) return false;
    this.rows.set(account.id, structuredClone(account));
    return true;
  }
  async setDefault() {
    return true;
  }
  async grants(): Promise<McpAccountGrant[]> {
    return [];
  }
  async saveGrant() {
    return true;
  }
  async revokeGrant() {}
  async selection(): Promise<McpChatAccountSelection | undefined> {
    return undefined;
  }
  async saveSelection() {
    return true;
  }
}
const baseline: McpIntegrationDefinition = {
  reviewPolicy: "uninitialized",
  server: {
    id: "github-mcp",
    label: "GitHub",
    transport: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
    authentication: { type: "token", sharedAllowed: false },
  },
  enabled: false,
  reviewed: { tools: [], resources: [], prompts: [] },
};
const start: McpSetupStart = {
  providerId: "github",
  authentication: "token",
  initializePolicy: true,
  account: { label: "GitHub account", scope: "personal", authentication: "token" },
  values: { accessToken: "synthetic-credential" },
};
function fixture(initial?: McpIntegrationDefinition) {
  const definitions = new Map<string, McpIntegrationDefinition>();
  const authored = new Map<string, McpIntegrationDefinition>();
  if (initial) {
    definitions.set(initial.server.id, structuredClone(initial));
    authored.set(initial.server.id, structuredClone(initial));
  }
  let failPublication = false;
  const publish = vi.fn(
    async (
      next: McpIntegrationDefinition,
      _actor: string,
      expected?: string | null,
      resume = false
    ) => {
      const previous = authored.get(next.server.id);
      if (
        (previous ? mcpServerRevision(previous) : null) !== expected &&
        !(resume && previous && mcpServerRevision(previous) === mcpServerRevision(next))
      )
        throw new Error("Revision conflict");
      authored.set(next.server.id, structuredClone(next));
      if (failPublication) {
        failPublication = false;
        throw new Error("Publication failed after commit");
      }
      definitions.set(next.server.id, structuredClone(next));
    }
  );
  const store: McpDefinitionStore<string> = {
    get: (id) => definitions.get(id),
    list: () => [...definitions.values()],
    put: (next, actor, expected) => publish(next, actor, expected),
    resumePut: (next, actor, expected) => publish(next, actor, expected, true),
    remove: async (id) => {
      definitions.delete(id);
    },
  };
  const tool: McpToolHandle = {
    kind: "tool",
    name: "search",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    identity: {
      serverId: "github-mcp",
      accountId: "account",
      subjectId: "user",
      configurationRevision: "revision",
    },
  };
  const discovery = {
    tools: [tool],
    resources: [],
    resourceTemplates: [],
    prompts: [],
  } satisfies McpDiscovery;
  const client: McpSession = {
    connect: async () => ({
      protocolVersion: "2025-11-25",
      name: "GitHub",
      version: "1",
      capabilities: { tools: true, resources: false, prompts: false },
    }),
    discover: vi.fn(async () => discovery),
    close: async () => {},
    callTool: async () => {
      throw new Error("Setup cannot execute tools");
    },
    readResource: async () => {
      throw new Error("Setup cannot read content");
    },
    getPrompt: async () => {
      throw new Error("Setup cannot render prompts");
    },
  };
  const integrations = new McpIntegrationService(
    store,
    {
      bind: async (input) => ({
        serverId: input.server.id,
        serverRevision: input.serverRevision,
        accountId: input.caller.accountId ?? null,
        accountRevision: "1",
        subjectId: input.caller.principal.id,
        authorizationId: "authorization",
      }),
      revalidate: async () => {},
      use: async (_binding, _server, callback) => callback(client),
    },
    { record: async () => {} }
  );
  const accounts = new Accounts();
  let admin = true;
  let active = true;
  const authority = new McpAccountAuthority(accounts, {
    isActivePrincipal: async () => active,
    canManageShared: async () => admin,
    isTeamMember: async () => false,
  });
  const probe = vi.fn(async (_account: McpAccount, authorize: () => Promise<void>) => authorize());
  const writeSecrets = vi.fn(async () => ({
    accessToken: "secret://00000000-0000-4000-8000-000000000001",
  }));
  const lifecycleAudit = vi.fn(async () => {});
  const lifecycle = new McpAccountLifecycle({
    accounts,
    authority,
    probe,
    definition: async (key) => accountDefinitionForIntegration(integrations.get(key)),
    secrets: { write: writeSecrets, remove: async () => {} },
    audit: lifecycleAudit,
  });
  const operations = new Operations();
  const audit = vi.fn(async () => {});
  const setup = new McpSetupService({
    operations,
    integrations,
    accounts,
    lifecycle,
    catalog: MCP_CATALOG,
    audit,
    isActive: async () => active,
    canConfigure: async () => admin,
  });
  return {
    setup,
    integrations,
    definitions,
    authored,
    publish,
    client,
    discovery,
    tool,
    accounts,
    lifecycle,
    lifecycleAudit,
    operations,
    probe,
    writeSecrets,
    audit,
    setAdmin: (value: boolean) => {
      admin = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    failPublication: () => {
      failPublication = true;
    },
  };
}

describe("durable MCP setup", () => {
  it("keeps legacy provenance through preservation so explicit same-account recovery remains available", async () => {
    const { reviewPolicy: _provenance, ...legacy } = baseline;
    const f = fixture(legacy);
    const first = await f.setup.start("business", "user", "preserve", start, "actor");
    expect(first).toMatchObject({
      status: "done",
      access: { state: "preserved_empty", tools: 0, resources: 0, prompts: 0, enabled: true },
    });
    expect(f.integrations.get("github-mcp").reviewPolicy).toBeUndefined();
    const eligibility = await f.setup.eligibility("business", "user", "github-mcp");
    expect(eligibility).toMatchObject({ publishedReady: true, canUseStandardAccess: true });
    expect(f.client.discover).not.toHaveBeenCalled();
    const result = await f.setup.start(
      "business",
      "user",
      "standard",
      {
        integrationKey: "github-mcp",
        accountId: first.accountId,
        definitionRevision: eligibility.definitionRevision,
        initializePolicy: true,
        legacyEmptyPolicyConsent: "use_standard_access",
      },
      "actor"
    );
    expect(result).toMatchObject({
      status: "done",
      accountId: first.accountId,
      access: { state: "allowed", tools: 1, enabled: true },
    });
    expect(f.accounts.rows.size).toBe(1);
  });
  it("reports empty discovery honestly without reopening initial-policy consent", async () => {
    const f = fixture();
    f.discovery.tools.splice(0);
    const result = await f.setup.start("business", "user", "empty", start, "actor");
    expect(result).toMatchObject({
      status: "done",
      access: { state: "discovered_empty", tools: 0, resources: 0, prompts: 0, enabled: true },
    });
    expect(await f.setup.eligibility("business", "user", "github-mcp")).toMatchObject({
      canUseStandardAccess: false,
      access: { state: "initial_empty" },
    });
  });
  it("does not infer legacy recovery from an old desired digest after a no-op custom review", async () => {
    const custom = { ...baseline, enabled: true, reviewPolicy: "custom" as const };
    const { reviewPolicy: _provenance, ...legacy } = baseline;
    const f = fixture(legacy);
    await f.setup.start("business", "user", "old-preserve", start, "actor");
    const saved = f.operations.rows.get("old-preserve");
    if (!saved) throw new Error("Missing historical operation");
    f.operations.rows.set(saved.id, { ...saved, desired: custom });
    f.definitions.set("github-mcp", custom);
    f.authored.set("github-mcp", custom);
    const before = mcpServerRevision(custom);
    await f.integrations.review(
      "github-mcp",
      custom.reviewed,
      {
        principal: { kind: "user", id: "user" },
      },
      "actor"
    );
    expect(mcpServerRevision(f.integrations.get("github-mcp"))).toBe(before);
    expect(await f.setup.eligibility("business", "user", "github-mcp")).toMatchObject({
      canUseStandardAccess: false,
      access: { state: "preserved_empty" },
    });
  });
  it("preserves ambiguous legacy empty catalog reviews instead of enabling all discovered capabilities", async () => {
    const { reviewPolicy: _provenance, ...legacy } = baseline;
    const f = fixture(legacy);
    const eligibility = await f.setup.eligibility("business", "user", "github-mcp");
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "done"
    );
    expect(f.integrations.get("github-mcp").reviewed).toEqual(legacy.reviewed);
    expect(eligibility.policy).toBe("preserve");
    expect(f.client.discover).not.toHaveBeenCalled();
  });
  it("repairs provider-revoked credentials on an otherwise ACTIVE current token account", async () => {
    const f = fixture(baseline);
    const created = await f.lifecycle.create("business", "github-mcp", "user", {
      label: "GitHub account",
      scope: "personal",
      authentication: "token",
      values: { accessToken: "synthetic-original" },
    });
    vi.mocked(f.client.discover).mockImplementation(async () => {
      if (f.accounts.rows.get(created.id)?.revision === 1)
        throw new McpError("authentication_required");
      return f.discovery;
    });
    const first = await f.setup.start(
      "business",
      "user",
      "operation",
      {
        integrationKey: "github-mcp",
        accountId: created.id,
        initializePolicy: true,
      },
      "actor"
    );
    const repaired = await f.setup.resume(
      "business",
      "user",
      "operation",
      {
        values: { accessToken: "synthetic-replacement" },
      },
      "actor"
    );
    expect(repaired).toMatchObject({ status: "done", accountId: created.id });
    expect(first).toMatchObject({ status: "needs_credentials", error: "reconnect_required" });
    expect(f.accounts.rows.size).toBe(1);
    expect(f.accounts.rows.get(created.id)?.revision).toBe(2);
    expect(f.writeSecrets).toHaveBeenCalledTimes(2);
  });
  it("requests same-account sign-in when OAuth discovery rejects a previously active account", async () => {
    const f = fixture({
      ...baseline,
      server: { ...baseline.server, authentication: { type: "oauth" } },
    });
    const created = await f.lifecycle.create("business", "github-mcp", "user", {
      label: "GitHub account",
      scope: "personal",
      authentication: "oauth",
    });
    const account = f.accounts.rows.get(created.id);
    if (!account) throw new Error("Missing account");
    f.accounts.rows.set(created.id, { ...account, status: "active" });
    vi.mocked(f.client.discover).mockRejectedValueOnce(new McpError("authentication_required"));
    expect(
      await f.setup.start(
        "business",
        "user",
        "operation",
        {
          integrationKey: "github-mcp",
          accountId: created.id,
          initializePolicy: true,
        },
        "actor"
      )
    ).toMatchObject({ status: "needs_sign_in", error: "reconnect_required" });
    f.accounts.rows.set(created.id, { ...account, status: "active", revision: 2 });
    expect(await f.setup.resume("business", "user", "operation", {}, "actor")).toMatchObject({
      status: "done",
      accountId: created.id,
    });
    expect(f.accounts.rows.size).toBe(1);
  });
  it.each(["snapshot-only", "desired-pending", "desired-published", "desired-empty"] as const)(
    "refuses an old broadening snapshot over ambiguous legacy policy at %s",
    async (phase) => {
      const { reviewPolicy: _provenance, ...legacy } = baseline;
      const f = fixture(legacy);
      const created = await f.lifecycle.create("business", "github-mcp", "user", {
        label: "GitHub account",
        scope: "personal",
        authentication: "token",
        values: { accessToken: "synthetic-original" },
      });
      const discovered = await f.integrations.discover("github-mcp", {
        principal: { kind: "user", id: "user" },
        accountId: created.id,
      });
      const snapshot = phase === "desired-empty" ? legacy.reviewed : discovered;
      const desired: McpIntegrationDefinition = {
        ...legacy,
        enabled: true,
        reviewed: snapshot,
        reviewPolicy: "initial",
      };
      await f.operations.insert({
        id: "old-operation",
        businessId: "business",
        principalId: "user",
        integrationKey: "github-mcp",
        accountId: created.id,
        accountRevision: created.revision,
        baseline: legacy,
        baseRevision: mcpServerRevision(legacy),
        intentDigest: "a".repeat(64),
        initializePolicy: true,
        confirmShared: false,
        status: "retry",
        snapshot,
        ...(phase === "snapshot-only" ? {} : { desired }),
      });
      if (phase !== "snapshot-only") f.authored.set("github-mcp", desired);
      if (phase === "desired-published") f.definitions.set("github-mcp", desired);
      const result = await f.setup.resume("business", "user", "old-operation", {}, "actor");
      expect(result.status).not.toBe("done");
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.integrations.get("github-mcp")).toEqual(
        phase === "desired-published" ? desired : legacy
      );
      expect(f.writeSecrets).toHaveBeenCalledOnce();
    }
  );
  it("records distinct revision-bound consent for standard access on legacy empty policy and reuses the account", async () => {
    const { reviewPolicy: _provenance, ...legacy } = baseline;
    const f = fixture(legacy);
    const created = await f.lifecycle.create("business", "github-mcp", "user", {
      label: "GitHub account",
      scope: "personal",
      authentication: "token",
      values: { accessToken: "synthetic-original" },
    });
    expect(await f.setup.eligibility("business", "user", "github-mcp")).toMatchObject({
      policy: "preserve",
      canUseStandardAccess: true,
    });
    const result = await f.setup.start(
      "business",
      "user",
      "operation",
      {
        integrationKey: "github-mcp",
        accountId: created.id,
        initializePolicy: true,
        definitionRevision: mcpServerRevision(legacy),
        legacyEmptyPolicyConsent: "use_standard_access",
      },
      "actor"
    );
    expect(result).toMatchObject({ status: "done", accountId: created.id });
    expect(f.operations.rows.get("operation")).toMatchObject({
      legacyEmptyPolicyConsent: "use_standard_access",
      baseRevision: mcpServerRevision(legacy),
    });
    expect(f.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyEmptyPolicyConsent: "use_standard_access",
      }),
      "integration.setup.resumed"
    );
    expect(f.integrations.get("github-mcp")).toMatchObject({
      reviewPolicy: "initial",
      reviewed: { tools: [{ name: "search", mutating: true, requiresApproval: true }] },
    });
    expect(f.writeSecrets).toHaveBeenCalledOnce();
    expect(f.accounts.rows.size).toBe(1);
  });
  it("resumes an explicitly authorized legacy snapshot without widening it or replacing credentials", async () => {
    const { reviewPolicy: _provenance, ...legacy } = baseline;
    const f = fixture(legacy);
    f.failPublication();
    const first = await f.setup.start(
      "business",
      "user",
      "operation",
      {
        ...start,
        definitionRevision: mcpServerRevision(legacy),
        legacyEmptyPolicyConsent: "use_standard_access",
      },
      "actor"
    );
    expect(first.status).toBe("retry");
    f.discovery.tools.push({ ...f.tool, name: "future-tool" });
    f.setAdmin(false);
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).toBe(
      "needs_admin"
    );
    f.setAdmin(true);
    const done = await f.setup.resume("business", "user", "operation", {}, "actor");
    expect(done).toMatchObject({ status: "done", accountId: first.accountId });
    expect(f.integrations.get("github-mcp").reviewed.tools.map((tool) => tool.name)).toEqual([
      "search",
    ]);
    expect(
      await f.setup.resume(
        "business",
        "user",
        "operation",
        {
          values: { accessToken: "synthetic-unrequested-replacement" },
        },
        "actor"
      )
    ).toEqual(done);
    expect(f.accounts.rows.size).toBe(1);
    expect(f.writeSecrets).toHaveBeenCalledOnce();
    expect(f.client.discover).toHaveBeenCalledOnce();
  });
  it.each(["member", "missing-revision", "stale-revision", "missing-initial-consent"] as const)(
    "rejects legacy standard-access consent with %s before persistence",
    async (failure) => {
      const { reviewPolicy: _provenance, ...legacy } = baseline;
      const f = fixture(legacy);
      if (failure === "member") f.setAdmin(false);
      await expect(
        f.setup.start(
          "business",
          "user",
          "operation",
          {
            ...start,
            initializePolicy: failure !== "missing-initial-consent",
            ...(failure === "missing-revision"
              ? {}
              : {
                  definitionRevision:
                    failure === "stale-revision" ? "0".repeat(64) : mcpServerRevision(legacy),
                }),
            legacyEmptyPolicyConsent: "use_standard_access",
          },
          "actor"
        )
      ).rejects.toBeDefined();
      expect(f.operations.rows.size).toBe(0);
      expect(f.accounts.rows.size).toBe(0);
      expect(f.publish).not.toHaveBeenCalled();
    }
  );
  it.each(["marked-empty", "uninitialized", "nonempty"] as const)(
    "refuses standard-access reset of %s policy",
    async (kind) => {
      const { reviewPolicy: _provenance, ...legacy } = baseline;
      const definition: McpIntegrationDefinition = {
        ...legacy,
        ...(kind === "marked-empty"
          ? { reviewPolicy: "custom" }
          : kind === "uninitialized"
            ? { reviewPolicy: "uninitialized" }
            : {}),
        ...(kind === "nonempty"
          ? {
              reviewed: {
                tools: [
                  {
                    name: "limited",
                    inputSchema: { type: "object" },
                    digest: "a".repeat(64),
                    mutating: true,
                    requiresApproval: true,
                  },
                ],
                resources: [],
                prompts: [],
              },
            }
          : {}),
      };
      const f = fixture(definition);
      expect(await f.setup.eligibility("business", "user", "github-mcp")).toMatchObject({
        canUseStandardAccess: false,
      });
      await expect(
        f.setup.start(
          "business",
          "user",
          "operation",
          {
            ...start,
            definitionRevision: mcpServerRevision(definition),
            legacyEmptyPolicyConsent: "use_standard_access",
          },
          "actor"
        )
      ).rejects.toBeDefined();
      expect(f.operations.rows.size).toBe(0);
      expect(f.publish).not.toHaveBeenCalled();
    }
  );
  it("one explicit Connect verifies, freezes conservative capabilities and publishes enabled together", async () => {
    const f = fixture();
    const result = await f.setup.start("business", "user", "operation", start, "actor");
    expect(result.status).toBe("done");
    expect(f.probe).toHaveBeenCalledOnce();
    expect(f.accounts.rows.size).toBe(1);
    expect(f.integrations.get("github-mcp")).toMatchObject({
      enabled: true,
      reviewPolicy: "initial",
      reviewed: { tools: [{ name: "search", mutating: true, requiresApproval: true }] },
    });
    expect(
      f.publish.mock.calls.map(([definition]) => [
        definition.enabled,
        definition.reviewed.tools.length,
      ])
    ).toEqual([
      [false, 0],
      [true, 1],
    ]);
    expect(JSON.stringify([...f.operations.rows.values()])).not.toContain("synthetic-credential");
  });
  it("lost-response retries preserve definition/account IDs and never rediscover later tools", async () => {
    const f = fixture();
    const first = await f.setup.start("business", "user", "operation", start, "actor");
    f.discovery.tools.push({ ...f.tool, name: "new-admin-tool" });
    const retried = await f.setup.start("business", "user", "operation", start, "actor");
    expect(retried).toEqual(first);
    expect(f.accounts.rows.size).toBe(1);
    expect(f.writeSecrets).toHaveBeenCalledOnce();
    expect(f.client.discover).toHaveBeenCalledOnce();
    expect(f.integrations.get("github-mcp").reviewed.tools.map((tool) => tool.name)).toEqual([
      "search",
    ]);
  });
  it("finishes an existing verified account without requiring or replacing a token", async () => {
    const f = fixture(baseline);
    const account = await f.lifecycle.create("business", "github-mcp", "user", {
      ...start.account,
      label: "GitHub",
      scope: "personal",
      authentication: "token",
      values: start.values,
    });
    const result = await f.setup.start(
      "business",
      "user",
      "finish",
      { integrationKey: "github-mcp", accountId: account.id, initializePolicy: true },
      "actor"
    );
    expect(result).toMatchObject({ status: "done", accountId: account.id });
    expect(f.writeSecrets).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "preserves custom policy including intentionally empty=%s",
    async (empty) => {
      const f = fixture();
      await f.setup.start("business", "user", "operation", start, "actor");
      const current = f.integrations.get("github-mcp");
      const custom = {
        ...current,
        enabled: false,
        reviewPolicy: "custom" as const,
        reviewed: empty ? { tools: [], resources: [], prompts: [] } : current.reviewed,
      };
      f.definitions.set("github-mcp", custom);
      f.authored.set("github-mcp", custom);
      const accountId = [...f.accounts.rows.keys()][0];
      const count = vi.mocked(f.client.discover).mock.calls.length;
      expect(
        (
          await f.setup.start(
            "business",
            "user",
            "finish",
            { integrationKey: "github-mcp", accountId, initializePolicy: true },
            "actor"
          )
        ).status
      ).toBe("done");
      expect(f.integrations.get("github-mcp").reviewed).toEqual(custom.reviewed);
      expect(vi.mocked(f.client.discover).mock.calls.length).toBe(count);
    }
  );
  it("requires initial consent and never initializes policy through a read", async () => {
    const f = fixture();
    expect(
      (
        await f.setup.start(
          "business",
          "user",
          "operation",
          { ...start, initializePolicy: false },
          "actor"
        )
      ).status
    ).toBe("needs_admin");
    const writes = f.publish.mock.calls.length;
    await f.setup.status("business", "user", "operation");
    expect(f.publish.mock.calls.length).toBe(writes);
    expect(f.client.discover).not.toHaveBeenCalled();
  });
  it("publication failure resumes the exact frozen snapshot despite later discovery changes", async () => {
    const f = fixture(baseline);
    f.failPublication();
    const { providerId: _provider, ...existingStart } = start;
    const first = await f.setup.start(
      "business",
      "user",
      "operation",
      { ...existingStart, integrationKey: "github-mcp" },
      "actor"
    );
    expect(first.status).toBe("retry");
    expect(f.integrations.get("github-mcp").enabled).toBe(false);
    f.discovery.tools.push({ ...f.tool, name: "new-admin-tool" });
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).toBe(
      "done"
    );
    expect(f.client.discover).toHaveBeenCalledOnce();
    expect(f.integrations.get("github-mcp").reviewed.tools.map((tool) => tool.name)).toEqual([
      "search",
    ]);
  });
  it("recovers a definition committed but not published before account creation", async () => {
    const f = fixture();
    f.failPublication();
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "retry"
    );
    expect(f.accounts.rows.size).toBe(0);
    expect(
      (await f.setup.resume("business", "user", "operation", { values: start.values }, "actor"))
        .status
    ).toBe("done");
    expect(f.accounts.rows.size).toBe(1);
  });
  it("repairs a failed pending token on the same reserved account ID", async () => {
    const f = fixture();
    f.probe.mockRejectedValueOnce(new Error("Synthetic provider refusal"));
    const first = await f.setup.start("business", "user", "operation", start, "actor");
    expect(first.status).toBe("needs_credentials");
    const second = await f.setup.resume(
      "business",
      "user",
      "operation",
      { values: { accessToken: "replacement-synthetic" } },
      "actor"
    );
    expect(second).toMatchObject({ status: "done", accountId: first.accountId });
    expect(f.accounts.rows.size).toBe(1);
  });
  it("OAuth completion needs the original principal's explicit resume and current admin authority", async () => {
    const f = fixture();
    const oauthStart: McpSetupStart = {
      ...start,
      values: undefined,
      authentication: "oauth",
      account: { label: "GitHub", scope: "personal", authentication: "oauth" },
    };
    const first = await f.setup.start("business", "user", "operation", oauthStart, "actor");
    expect(first.status).toBe("needs_sign_in");
    const account = [...f.accounts.rows.values()][0];
    if (!account) throw new Error("Missing account");
    f.accounts.rows.set(account.id, { ...account, status: "active" });
    await f.setup.status("business", "user", "operation");
    expect(f.integrations.get("github-mcp").enabled).toBe(false);
    await expect(
      f.setup.resume("business", "another-user", "operation", {}, "actor")
    ).rejects.toMatchObject({ code: "account_not_found" });
    f.setAdmin(false);
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).toBe(
      "needs_admin"
    );
    expect(f.integrations.get("github-mcp").enabled).toBe(false);
    f.setAdmin(true);
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).toBe(
      "done"
    );
    expect(f.accounts.rows.size).toBe(1);
  });
  it("members can connect only within existing enabled policy, never initialize it", async () => {
    const f = fixture({ ...baseline, enabled: true, reviewPolicy: "custom" });
    f.setAdmin(false);
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "done"
    );
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.client.discover).not.toHaveBeenCalled();
  });
  it("rejects replay under a different intent or inactive principal", async () => {
    const f = fixture();
    await f.setup.start("business", "user", "operation", start, "actor");
    await expect(
      f.setup.start("business", "user", "operation", { ...start, initializePolicy: false }, "actor")
    ).rejects.toMatchObject({ code: "conflict" });
    f.setActive(false);
    await expect(
      f.setup.resume("business", "user", "operation", {}, "actor")
    ).rejects.toMatchObject({ code: "principal_inactive" });
  });
  it("never completes after audit failure", async () => {
    const f = fixture();
    f.audit.mockRejectedValueOnce(new Error("Audit unavailable"));
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "retry"
    );
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
  });
  it("recovers an account-created audit outage without duplicating the pending account or credentials", async () => {
    const f = fixture();
    f.lifecycleAudit.mockRejectedValueOnce(new Error("Synthetic audit outage"));
    const first = await f.setup.start("business", "user", "operation", start, "actor");
    expect(first.status).toBe("retry");
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.accounts.rows.size).toBe(1);
    expect(await f.setup.resume("business", "user", "operation", {}, "actor")).toMatchObject({
      status: "done",
      accountId: first.accountId,
    });
    expect(f.accounts.rows.size).toBe(1);
    expect(f.writeSecrets).toHaveBeenCalledOnce();
  });
  it("preserves an explicitly empty advanced review across later configuration changes", async () => {
    const f = fixture(baseline);
    const review = { tools: [], resources: [], prompts: [] };
    await f.integrations.review(
      "github-mcp",
      review,
      { principal: { kind: "user", id: "user" } },
      "actor"
    );
    await f.integrations.configure(
      "github-mcp",
      {
        server: { ...baseline.server, label: "Renamed GitHub" },
        enabled: false,
      },
      "actor"
    );
    expect(f.integrations.get("github-mcp").reviewPolicy).toBe("custom");
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "done"
    );
    expect(f.integrations.get("github-mcp").reviewed).toEqual(review);
    expect(f.client.discover).toHaveBeenCalledOnce();
  });
  it("preserves unmarked legacy custom empty policy instead of migrating it", async () => {
    const { reviewPolicy: _provenance, ...legacy } = baseline;
    const custom = {
      ...legacy,
      server: {
        ...baseline.server,
        transport: { type: "streamable-http" as const, url: "https://custom.example.com/mcp" },
      },
    };
    const f = fixture(custom);
    const { providerId: _provider, ...input } = start;
    expect(
      (
        await f.setup.start(
          "business",
          "user",
          "operation",
          { ...input, integrationKey: "github-mcp" },
          "actor"
        )
      ).status
    ).toBe("done");
    expect(f.integrations.get("github-mcp").reviewed).toEqual(custom.reviewed);
    expect(f.client.discover).not.toHaveBeenCalled();
  });
  it("does not create a member account while the organization's policy is disabled", async () => {
    const f = fixture(baseline);
    f.setAdmin(false);
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "needs_admin"
    );
    expect(f.accounts.rows.size).toBe(0);
    expect(f.probe).not.toHaveBeenCalled();
  });
  it("requires explicit shared consent and never converts shared setup into personal Chat consent", async () => {
    const f = fixture({
      ...baseline,
      server: { ...baseline.server, authentication: { type: "token", sharedAllowed: true } },
    });
    const input: McpSetupStart = {
      ...start,
      account: { label: "GitHub shared", scope: "shared", authentication: "token" },
    };
    await expect(
      f.setup.start("business", "user", "operation", input, "actor")
    ).rejects.toMatchObject({ code: "shared_consent_required" });
    const result = await f.setup.start(
      "business",
      "user",
      "operation",
      { ...input, confirmShared: true },
      "actor"
    );
    expect(result.status).toBe("done");
    expect([...f.accounts.rows.values()][0]?.owner.scope).toBe("shared");
    expect(await f.accounts.selection()).toBeUndefined();
    f.setAdmin(false);
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).not.toBe(
      "done"
    );
  });
  it("refuses account revision drift, concurrent policy edits and expired account state", async () => {
    const f = fixture(baseline);
    const { providerId: _provider, ...input } = start;
    f.failPublication();
    const first = await f.setup.start(
      "business",
      "user",
      "operation",
      { ...input, integrationKey: "github-mcp" },
      "actor"
    );
    const account = [...f.accounts.rows.values()][0];
    if (!account) throw new Error("Missing account");
    f.accounts.rows.set(account.id, { ...account, revision: account.revision + 1 });
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).error).toBe(
      "account_binding_changed"
    );
    f.accounts.rows.set(account.id, { ...account, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).error).toBe(
      "account_expired"
    );
    f.accounts.rows.set(account.id, account);
    f.definitions.set("github-mcp", { ...baseline, reviewPolicy: "custom" });
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).error).toBe(
      "definition_changed"
    );
    expect(first.accountId).toBe(account.id);
    expect(f.integrations.get("github-mcp").enabled).toBe(false);
  });
  it("reauthorizes after discovery and does not enable after the account or admin authority changes", async () => {
    const f = fixture();
    vi.mocked(f.client.discover).mockImplementationOnce(async () => {
      f.setAdmin(false);
      return f.discovery;
    });
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "needs_admin"
    );
    expect(f.integrations.get("github-mcp").enabled).toBe(false);
    f.setAdmin(true);
    const account = [...f.accounts.rows.values()][0];
    if (!account) throw new Error("Missing account");
    f.accounts.rows.set(account.id, {
      ...account,
      status: "revoked",
      revision: account.revision + 1,
    });
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).not.toBe(
      "done"
    );
  });
  it("serializes the same operation and refuses unauthenticated account lookup", async () => {
    const f = fixture();
    await f.setup.start("business", "user", "operation", start, "actor");
    expect(
      await f.setup.list("business", "other", "github-mcp", [...f.accounts.rows.keys()][0] ?? "")
    ).toEqual([]);
    f.operations.leases.set("operation", "other-request");
    await expect(
      f.setup.resume("business", "user", "operation", {}, "actor")
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("discovers and verifies a new authless service without inventing an account", async () => {
    const f = fixture({
      ...baseline,
      server: { ...baseline.server, authentication: { type: "none" } },
      reviewPolicy: "uninitialized",
    });
    expect(
      (
        await f.setup.start(
          "business",
          "user",
          "operation",
          { integrationKey: "github-mcp", initializePolicy: true },
          "actor"
        )
      ).status
    ).toBe("done");
    expect(f.accounts.rows.size).toBe(0);
    expect(f.client.discover).toHaveBeenCalledOnce();
    expect(f.probe).not.toHaveBeenCalled();
  });
  it("does not rediscover after completion audit fails following successful publication", async () => {
    const f = fixture();
    f.audit
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("Completion audit unavailable"));
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "retry"
    );
    expect(f.integrations.get("github-mcp").enabled).toBe(true);
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).toBe(
      "done"
    );
    expect(f.client.discover).toHaveBeenCalledOnce();
    expect(f.accounts.rows.size).toBe(1);
  });
  it("verifies custom authless connectivity without adding its discovered tools to an empty policy", async () => {
    const f = fixture({
      ...baseline,
      server: { ...baseline.server, authentication: { type: "none" } },
      reviewPolicy: "custom",
    });
    vi.mocked(f.client.discover).mockRejectedValueOnce(new Error("Synthetic unavailable service"));
    const input = { integrationKey: "github-mcp", initializePolicy: true };
    expect((await f.setup.start("business", "user", "operation", input, "actor")).status).toBe(
      "retry"
    );
    expect(f.integrations.get("github-mcp").enabled).toBe(false);
    expect((await f.setup.resume("business", "user", "operation", {}, "actor")).status).toBe(
      "done"
    );
    expect(f.integrations.get("github-mcp").reviewed).toEqual(baseline.reviewed);
    expect(f.accounts.rows.size).toBe(0);
  });
  it("exposes read-only trusted eligibility and the complete published definition revision", async () => {
    const f = fixture({ ...baseline, enabled: true });
    expect(await f.setup.eligibility("business", "user", "github-mcp")).toEqual({
      definitionRevision: mcpServerRevision({ ...baseline, enabled: true }),
      policy: "initialize",
      publishedReady: false,
      canConfigure: true,
      canUseStandardAccess: false,
      access: { enabled: true, state: "uninitialized", tools: 0, resources: 0, prompts: 0 },
    });
    expect(f.operations.rows.size).toBe(0);
    expect(f.accounts.rows.size).toBe(0);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.client.discover).not.toHaveBeenCalled();
    f.setAdmin(false);
    expect((await f.setup.start("business", "user", "operation", start, "actor")).status).toBe(
      "needs_admin"
    );
    expect(f.accounts.rows.size).toBe(0);
  });
  it("separates published legacy settings from usable access and standard-access eligibility", async () => {
    const { reviewPolicy: _provenance, ...legacy } = baseline;
    const custom = {
      ...legacy,
      server: {
        ...baseline.server,
        transport: { type: "streamable-http" as const, url: "https://custom.example.com/mcp" },
      },
      enabled: true,
    };
    const f = fixture(custom);
    expect(await f.setup.eligibility("business", "user", "github-mcp")).toMatchObject({
      policy: "preserve",
      publishedReady: true,
      canUseStandardAccess: true,
      access: { state: "preserved_empty", tools: 0 },
    });
    f.definitions.set("github-mcp", { ...custom, reviewPolicy: "custom" });
    expect(await f.setup.eligibility("business", "user", "github-mcp")).toMatchObject({
      policy: "preserve",
      publishedReady: true,
      canUseStandardAccess: false,
      access: { state: "preserved_empty", tools: 0 },
    });
  });
  it("rejects a stale observed definition before persisting intent, account or publication", async () => {
    const f = fixture(baseline);
    await expect(
      f.setup.start(
        "business",
        "user",
        "operation",
        {
          ...start,
          definitionRevision: "0".repeat(64),
        },
        "actor"
      )
    ).rejects.toMatchObject({ code: "definition_changed" });
    expect(f.operations.rows.size).toBe(0);
    expect(f.accounts.rows.size).toBe(0);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(["expired", "stale"] as const)(
    "repairs an %s ACTIVE token account on its original ID before freezing policy",
    async (state) => {
      const f = fixture(baseline);
      const created = await f.lifecycle.create("business", "github-mcp", "user", {
        label: "GitHub account",
        scope: "personal",
        authentication: "token",
        values: { accessToken: "synthetic-original" },
      });
      const account = f.accounts.rows.get(created.id);
      if (!account) throw new Error("Missing account");
      f.accounts.rows.set(created.id, {
        ...account,
        ...(state === "expired"
          ? { expiresAt: "2000-01-01T00:00:00.000Z" }
          : { definitionDigest: "0".repeat(64) }),
      });
      const first = await f.setup.start(
        "business",
        "user",
        "operation",
        {
          integrationKey: "github-mcp",
          accountId: created.id,
          initializePolicy: true,
          definitionRevision: mcpServerRevision(baseline),
        },
        "actor"
      );
      expect(first.status).not.toBe("done");
      expect(f.client.discover).not.toHaveBeenCalled();
      expect(
        await f.setup.resume(
          "business",
          "user",
          "operation",
          {
            values: { accessToken: "synthetic-replacement" },
          },
          "actor"
        )
      ).toMatchObject({ status: "done", accountId: created.id });
      expect(f.accounts.rows.size).toBe(1);
      expect(f.accounts.rows.get(created.id)).toMatchObject({
        status: "active",
        revision: 2,
        expiresAt: null,
        definitionDigest: accountDefinitionForIntegration(baseline).definitionDigest,
      });
      expect(f.writeSecrets).toHaveBeenCalledTimes(2);
    }
  );
});
