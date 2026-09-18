import {
  accountDefinitionForIntegration,
  McpAccountAuthority,
  type McpAccountRepository,
} from "@tulipfarm/integrations";
import {
  canonicalHash,
  type McpAccount,
  type McpAccountGrant,
  type McpIntegrationDefinition,
  mcpToolName,
} from "@tulipfarm/schema";
import type { BundleDefinition, RuntimeBundle } from "@tulipfarm/soul";
import type {
  NativeChannelInboxRecord,
  NativeChannelRoutineRoute,
  PersistedRun,
  QueryResult,
  RunLineage,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  assertMcpRoutineUnchanged,
  type McpHostContextDeps,
  McpHostContextResolver,
  mcpRoutineConfigurationDigest,
} from "./mcp-context";

function bundle(
  instructions = "Read the selected ticket.",
  integration?: McpIntegrationDefinition
): RuntimeBundle {
  const document = (id: string, kind: string) => ({
    apiVersion: "tulipfarm.ai/v1",
    kind,
    metadata: {
      id:
        id === "routine"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      slug: id,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec:
      kind === "Routine"
        ? {
            owner: "muskan",
            start: "Read",
            states: [
              {
                name: "Read",
                type: "tool",
                end: true,
                toolRef: { name: "example_read", version: "1.0.0" },
                action: "read",
              },
            ],
          }
        : {
            owner: "muskan",
            instructions: { path: "instructions.md" },
            modelProfile: "default",
            autonomy: "execute_low_risk",
            trustTier: "business_authored",
            allowedTools:
              integration?.reviewed.tools.map((tool) =>
                mcpToolName(integration.server.id, tool.name)
              ) ?? [],
          },
  });
  const definitions: BundleDefinition[] = ["routine", "agent"].map((id) => ({
    id,
    kind: id === "routine" ? "Routine" : "Agent",
    slug: id,
    authoredVersion: 1,
    hash: canonicalHash(document(id, id === "routine" ? "Routine" : "Agent")),
    document: document(id, id === "routine" ? "Routine" : "Agent"),
    references:
      id === "routine"
        ? [
            {
              field: "/spec/states/0/agentRef",
              id: "agent",
              kind: "Agent",
              slug: "agent",
              authoredVersion: 1,
            },
          ]
        : [],
  }));
  const assets = [
    {
      ownerDefinitionId: "agent",
      path: "instructions.md",
      digest: canonicalHash(instructions),
      content: instructions,
    },
  ];
  if (integration)
    assets.push({
      ownerDefinitionId: `Integration:${integration.server.id}`,
      path: "mcp.yaml",
      digest: canonicalHash(integration),
      content: JSON.stringify(integration),
    });
  return {
    digest: canonicalHash({ definitions, assets }),
    businessId: "business-1",
    changesetId: "change-1",
    commitSha: "commit-1",
    definitions,
    assets,
    get: (kind, slug) => definitions.find((item) => item.kind === kind && item.slug === slug),
    getById: (id) => definitions.find((item) => item.id === id),
    asset: (id, path) => assets.find((item) => item.ownerDefinitionId === id && item.path === path),
  };
}

describe("MCP Routine approval material", () => {
  it("invalidates approval when Agent instructions, account or destination changes", () => {
    const account = { id: "account-1", revision: 1 };
    const original = mcpRoutineConfigurationDigest(bundle(), "routine", account, "private");
    expect(
      mcpRoutineConfigurationDigest(bundle("Write the ticket."), "routine", account, "private")
    ).not.toBe(original);
    expect(
      mcpRoutineConfigurationDigest(bundle(), "routine", { ...account, revision: 2 }, "private")
    ).not.toBe(original);
    expect(
      mcpRoutineConfigurationDigest(bundle(), "routine", { ...account, id: "account-2" }, "private")
    ).not.toBe(original);
    expect(mcpRoutineConfigurationDigest(bundle(), "routine", account, "shared-channel")).not.toBe(
      original
    );
    expect(() =>
      assertMcpRoutineUnchanged(bundle(), bundle("Write the ticket."), "routine")
    ).toThrow("Routine changed");
  });

  class ContextRuns {
    readonly rows = new Map<string, PersistedRun>();
    readonly edges: RunLineage[] = [];
    async find(_businessId: string, id: string) {
      return this.rows.get(id) ?? null;
    }
    async listLineage(_businessId: string, id: string) {
      return this.edges.filter((edge) => edge.targetRunId === id);
    }
  }

  class EmptyDatabase {
    async query<Row>(): Promise<QueryResult<Row>> {
      return { rows: [] };
    }
  }

  function contextRun(id: string, principal: { kind: string; id: string }): PersistedRun {
    return {
      id,
      businessId: "business-1",
      source: "conversation",
      bundle: { digest: "bundle-1", routineId: "chat", routineVersion: "1" },
      identity: {
        initiator: principal,
        effectiveSubject: principal,
        guardrailContextRef: "guard-1",
      },
      status: "running",
      version: 1,
      createdAt: "2026-09-18T00:00:00Z",
      startedAt: "2026-09-18T00:00:00Z",
      finishedAt: null,
      resultArtifactId: null,
      errorEvidenceRef: null,
      leaseOwner: "worker",
      leaseGeneration: 1,
      leaseExpiresAt: "2026-09-18T01:00:00Z",
    };
  }

  describe("trusted MCP caller contexts", () => {
    function setup(
      activeBundle: () => Promise<RuntimeBundle | undefined> = async () => undefined,
      options: Partial<
        Pick<McpHostContextDeps, "accounts" | "accountAuthority" | "nativeRoutes" | "bundles">
      > = {}
    ) {
      const runs = new ContextRuns();
      const user = { kind: "user", id: "muskan" };
      runs.rows.set("root", { ...contextRun("root", user), status: "waiting" });
      runs.rows.set("child", contextRun("child", { kind: "agent", id: "helper" }));
      runs.edges.push({
        businessId: "business-1",
        sourceRunId: "root",
        targetRunId: "child",
        relation: "child",
        createdAt: "2026-09-18T00:00:00Z",
      });
      const resolver = new McpHostContextResolver({
        businessId: "business-1",
        db: new EmptyDatabase(),
        runs,
        turns: { findTurnByRunId: async () => undefined },
        conversations: { findById: async () => null },
        accounts: { list: async () => [], grants: async () => [] },
        accountAuthority: {
          resolveForRefresh: async () => {
            throw new Error("No account is available in this fixture");
          },
          resolve: async () => {
            throw new Error("No account is available in this fixture");
          },
        },
        nativeRoutes: { routineRoutes: async () => [], findByRun: async () => undefined },
        activeBundle,
        bundles: { load: async () => undefined },
        ...options,
      });
      return { resolver, runs };
    }
    it("keeps the original caller through Agent delegation", async () => {
      const { resolver } = setup();
      expect(
        await resolver.callerForRun({ runId: "child", principal: { kind: "agent", id: "helper" } })
      ).toEqual({ principal: { kind: "user", id: "muskan" }, runId: "child" });
    });
    it("rejects forged current callers and cancelled ancestors", async () => {
      const { resolver, runs } = setup();
      await expect(
        resolver.callerForRun({ runId: "child", principal: { kind: "user", id: "muskan" } })
      ).rejects.toMatchObject({ code: "account_access_denied" });
      runs.rows.set("root", {
        ...contextRun("root", { kind: "user", id: "muskan" }),
        status: "cancelled",
      });
      await expect(
        resolver.callerForRun({ runId: "child", principal: { kind: "agent", id: "helper" } })
      ).rejects.toMatchObject({ code: "account_access_denied" });
      await expect(resolver.knowledgeReaderForRun("child")).resolves.toBeUndefined();
    });
    it("uses interactive authority without fabricating a Conversation for setup", async () => {
      const { resolver } = setup();
      await expect(
        resolver.resolve(
          { principal: { kind: "user", id: "muskan" } },
          { businessId: "business-1", integrationKey: "example", definitionDigest: "a".repeat(64) },
          { kind: "discovery", name: "*" }
        )
      ).resolves.toMatchObject({
        kind: "interactive",
        principalId: "muskan",
        purpose: "discovery",
      });
    });
    it("pins native Routine approval to published instructions and exact destination", async () => {
      let active = bundle();
      const { resolver } = setup(async () => active);
      const route = {
        routineId: "routine",
        provider: "github" as const,
        integrationId: "installation-1",
        destination: "TulipFarm/tulipfarm",
        eventType: "github.push",
      };
      const original = await resolver.nativeRoutineAuthority(route);
      expect(original).toMatchObject({
        definitionRef: "published:routine:routine",
        principal: { kind: "user", id: "muskan" },
      });
      expect(
        (
          await resolver.nativeRoutineAuthority({
            ...route,
            destination: "TulipFarm/another",
          })
        ).configurationDigest
      ).not.toBe(original.configurationDigest);
      active = bundle("Send the ticket to a different destination.");
      expect((await resolver.nativeRoutineAuthority(route)).configurationDigest).not.toBe(
        original.configurationDigest
      );
      await expect(setup().resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "native_routine_not_published",
      });
    });
    it("requires live shared grants bound to the stored native destination before admission", async () => {
      const integration: McpIntegrationDefinition = {
        server: {
          id: "example",
          label: "Example",
          transport: { type: "streamable-http", url: "https://mcp.example.com" },
          authentication: { type: "token", sharedAllowed: true },
        },
        enabled: true,
        reviewed: {
          tools: [
            {
              name: "read",
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
      let active = bundle(undefined, integration);
      const pinnedBundle = active;
      let event: NativeChannelInboxRecord | undefined;
      const account: McpAccount = {
        id: "shared",
        businessId: "business-1",
        integrationKey: "example",
        definitionDigest: accountDefinitionForIntegration(integration).definitionDigest,
        label: "Shared",
        owner: { scope: "shared" },
        status: "active",
        authentication: "token",
        isDefault: false,
        revision: 1,
        secretBindings: {},
        expiresAt: null,
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
      };
      const grants: McpAccountGrant[] = [];
      const repository: McpAccountRepository = {
        get: async () => account,
        list: async () => [account],
        grants: async () => grants,
        save: async () => true,
        setDefault: async () => true,
        saveGrant: async () => true,
        revokeGrant: async () => {},
        selection: async () => undefined,
        saveSelection: async () => true,
      };
      const accountAuthority = new McpAccountAuthority(repository, {
        isActivePrincipal: async () => true,
        isTeamMember: async () => false,
        canManageShared: async () => false,
      });
      let route: NativeChannelRoutineRoute = {
        id: "route-1",
        businessId: "business-1",
        provider: "github",
        integrationId: "installation-1",
        destination: "TulipFarm/tulipfarm",
        eventType: "github.push",
        routineId: "routine",
        enabled: false,
        authority: null,
      };
      const { resolver, runs } = setup(async () => active, {
        accounts: repository,
        accountAuthority,
        bundles: { load: async () => pinnedBundle },
        nativeRoutes: {
          routineRoutes: async (_businessId, provider) => (provider === "github" ? [route] : []),
          findByRun: async () => event,
        },
      });
      await expect(resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "routine_approval_required",
      });
      const subject = await resolver.routineGrantSubject(account, "routine");
      const grant: McpAccountGrant = {
        businessId: "business-1",
        accountId: account.id,
        accountRevision: account.revision,
        subject,
        grantedBy: "admin",
        grantedAt: "2026-09-18T00:00:00Z",
      };
      grants.push(grant);
      const authority = await resolver.nativeRoutineAuthority(route);
      route = { ...route, authority, enabled: true };
      expect(await resolver.routineGrantSubject(account, "routine")).toEqual(subject);
      expect(await resolver.nativeRoutineAuthority(route)).toEqual(authority);
      event = {
        id: "event-1",
        businessId: "business-1",
        provider: "github",
        integrationId: route.integrationId,
        externalAppId: "app-1",
        externalTenantId: "tenant-1",
        deliveryId: "delivery-1",
        payloadDigest: canonicalHash({}),
        eventType: route.eventType,
        payload: {},
        binding: { routineRoute: route },
        status: "dispatched",
        attempts: 1,
        leaseToken: null,
        leaseExpiresAt: null,
        runId: "native",
      };
      const run = contextRun("native", { kind: "user", id: "muskan" });
      runs.rows.set(run.id, {
        ...run,
        source: "routine",
        bundle: { digest: pinnedBundle.digest, routineId: "routine", routineVersion: "1" },
        identity: {
          ...run.identity,
          initiator: { kind: "integration", id: route.integrationId },
        },
      });
      const resolve = () =>
        resolver.resolve(
          { principal: { kind: "user", id: "muskan" }, runId: run.id },
          {
            businessId: "business-1",
            integrationKey: integration.server.id,
            definitionDigest: account.definitionDigest,
          },
          { kind: "tool", name: "read" }
        );
      await expect(resolve()).resolves.toMatchObject({
        visibility: "shared",
        accountId: account.id,
        accountRevision: 1,
      });
      await expect(resolver.knowledgeReaderForRun(run.id)).resolves.toBeUndefined();
      account.revision = 2;
      grants[0] = {
        ...grant,
        accountRevision: 2,
        subject: await resolver.routineGrantSubject(account, "routine"),
      };
      await expect(resolve()).rejects.toMatchObject({ code: "routine_approval_required" });
      account.revision = 1;
      grants[0] = grant;

      account.status = "revoked";
      await expect(resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "account_unavailable",
      });
      account.status = "active";
      account.owner = { scope: "personal", principalId: "muskan" };
      await expect(resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "routine_approval_required",
      });
      account.owner = { scope: "shared" };
      route = { ...route, destination: "TulipFarm/another" };
      await expect(resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "routine_approval_required",
      });
      route = { ...route, destination: "TulipFarm/tulipfarm" };
      active = bundle("Send records elsewhere.", integration);
      await expect(resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "routine_approval_required",
      });
      active = bundle(undefined, {
        ...integration,
        reviewed: {
          ...integration.reviewed,
          tools: integration.reviewed.tools.map((tool) => ({ ...tool, mutating: true })),
        },
      });
      await expect(resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "routine_approval_required",
      });
      active = bundle(undefined, integration);
      grants.length = 0;
      await expect(resolver.nativeRoutineAuthority(route)).rejects.toMatchObject({
        code: "routine_approval_required",
      });
    });
  });
  it("permits unchanged material across unrelated publication changes", () => {
    const original = bundle();
    expect(() =>
      assertMcpRoutineUnchanged(
        original,
        { ...original, digest: "different-publication" },
        "routine"
      )
    ).not.toThrow();
    expect(() => assertMcpRoutineUnchanged(original, undefined, "routine")).toThrow(
      "Routine changed"
    );
  });
});
