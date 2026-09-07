import type {
  KnowledgeChunkEmission,
  KnowledgeSourceEmission,
  OimHookPhaseRunner,
  OimKnowledgeCheckpoint,
  ProviderIdentityLinkPort,
  VerifiedEmailPrincipalPort,
} from "@tulipfarm/integrations";
import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import type { OimHook } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { RequestContext } from "@tulipfarm/tool-host";
import { toToolDef } from "@tulipfarm/tool-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import {
  INTEGRATION_KNOWLEDGE_TOOLS,
  type IntegrationKnowledgeToolContext,
} from "./knowledge-tools";

const SLUG = "wiki";

function integration(overrides: Partial<SoulIntegration> = {}): SoulIntegration {
  return {
    slug: SLUG,
    sourceIntegration: "wiki",
    oimManifest: knowledgeManifestFixture(),
    ...overrides,
  } as SoulIntegration;
}

/** A stand-in for a registered declarative Tool, so the port under test dispatches for real. */
function providerTool(
  name: string,
  respond: (args: Record<string, unknown>, ctx: RequestContext) => unknown
): ReturnType<typeof toToolDef> {
  return {
    name,
    tier: "integration",
    mutating: false,
    description: name,
    inputSchema: { type: "object" },
    execute: async (args, ctx) => ({
      success: true,
      data: respond((args ?? {}) as Record<string, unknown>, ctx),
    }),
  } as ReturnType<typeof toToolDef>;
}

class MemoryCheckpoints {
  readonly saved: OimKnowledgeCheckpoint[] = [];
  private readonly rows = new Map<string, OimKnowledgeCheckpoint>();
  seed(checkpoint: OimKnowledgeCheckpoint): void {
    this.rows.set(`${checkpoint.integrationId}\u0000${checkpoint.scopeKey}`, checkpoint);
  }
  async load(integrationId: string, scopeKey: string): Promise<OimKnowledgeCheckpoint | undefined> {
    return this.rows.get(`${integrationId}\u0000${scopeKey}`);
  }
  async save(checkpoint: OimKnowledgeCheckpoint): Promise<void> {
    this.saved.push(checkpoint);
    this.rows.set(`${checkpoint.integrationId}\u0000${checkpoint.scopeKey}`, checkpoint);
  }
}

class MemorySink {
  readonly emissions: KnowledgeSourceEmission[] = [];
  readonly chunks: KnowledgeChunkEmission[] = [];
  async emitSource(source: KnowledgeSourceEmission): Promise<void> {
    this.emissions.push(source);
  }
  async emitChunk(chunk: KnowledgeChunkEmission): Promise<void> {
    this.chunks.push(chunk);
  }
  async removeSourceContent(): Promise<void> {}
  async removeChunk(): Promise<void> {}
}

const ctxRequest: RequestContext = { userId: "u1", runId: "run1" } as RequestContext;

describe("integration Knowledge Tools", () => {
  let registry: ToolRegistry;
  let checkpoints: MemoryCheckpoints;
  let sink: MemorySink;
  let integrations: SoulIntegration[];
  let links: ProviderIdentityLinkPort;
  let emails: VerifiedEmailPrincipalPort | undefined;
  let verifiedEmailDomains: readonly string[];
  let oimRuntimeHost: IntegrationKnowledgeToolContext["oimRuntimeHost"];

  function context(): IntegrationKnowledgeToolContext {
    return {
      businessId: "b1",
      integrations: () => integrations,
      registry,
      checkpoints,
      sink,
      links,
      ...(emails === undefined ? {} : { emails }),
      policy: { verifiedEmailDomains },
      oimRuntimeHost,
      requestContext: ctxRequest,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
  }

  function run(toolName: string, args: Record<string, unknown>) {
    const definition = INTEGRATION_KNOWLEDGE_TOOLS.find((tool) => tool.name === toolName);
    if (definition === undefined) throw new Error(`no tool ${toolName}`);
    const ctx = context();
    return toToolDef(definition, () => ctx).execute(args, ctxRequest);
  }

  beforeEach(() => {
    registry = new ToolRegistry({ defaultDeny: true });
    checkpoints = new MemoryCheckpoints();
    sink = new MemorySink();
    integrations = [integration()];
    links = { linkedPrincipal: async () => ({ kind: "user", id: "u1" }) };
    emails = undefined;
    verifiedEmailDomains = [];
    oimRuntimeHost = {
      authorizeIntegration: async () => {},
      hookRunnerFor: async () => undefined,
    };
  });

  describe("integration_knowledge_profile", () => {
    it("describes what the manifest can index", async () => {
      const result = await run("integration_knowledge_profile", { integration: SLUG });
      expect(result.success).toBe(true);
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data.integrationId).toBe("wiki");
      expect(data.requiredChoices).toBeInstanceOf(Array);
    });

    it("serves the Knowledge guide the Integration shipped", async () => {
      integrations = [integration({ knowledgeGuide: "Read spaces before pages." })];
      const result = await run("integration_knowledge_profile", { integration: SLUG });
      expect((result as { data: { guide?: string } }).data.guide).toBe("Read spaces before pages.");
    });

    it("refuses an Integration that is not installed", async () => {
      const result = await run("integration_knowledge_profile", { integration: "nope" });
      expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
    });

    it("uses an installed OIM Integration without the legacy connection.enabled flag", async () => {
      const result = await run("integration_knowledge_profile", { integration: SLUG });
      expect(result).toMatchObject({ success: true });
    });

    it("refuses an Integration that declares no knowledge profile", async () => {
      const manifest = knowledgeManifestFixture();
      const stripped = { ...manifest, knowledge: undefined };
      integrations = [integration({ oimManifest: stripped } as Partial<SoulIntegration>)];
      const result = await run("integration_knowledge_profile", { integration: SLUG });
      expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
    });

    it("rejects an unknown argument rather than ignoring it", async () => {
      const result = await run("integration_knowledge_profile", {
        integration: SLUG,
        scopes: ["x"],
      });
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    });
  });

  describe("integration_knowledge_scopes", () => {
    it("lists the scopes the provider enumerates", async () => {
      registry.register(
        providerTool("wiki_list_spaces", () => ({
          results: [
            { key: "ENG", name: "Engineering" },
            { key: "OPS", name: "Operations" },
          ],
        }))
      );
      const result = await run("integration_knowledge_scopes", {
        integration: SLUG,
        source_kind: "space",
        connection_id: "conn-1",
      });
      expect(result).toMatchObject({
        success: true,
        data: {
          scopes: [
            { id: "ENG", label: "Engineering" },
            { id: "OPS", label: "Operations" },
          ],
        },
      });
    });

    it("refuses a source kind the manifest does not declare", async () => {
      const result = await run("integration_knowledge_scopes", {
        integration: SLUG,
        source_kind: "mailbox",
        connection_id: "conn-1",
      });
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    });

    it("reports the Tool being unavailable rather than indexing nothing silently", async () => {
      const result = await run("integration_knowledge_scopes", {
        integration: SLUG,
        source_kind: "space",
        connection_id: "conn-1",
      });
      expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
    });
  });

  describe("integration_knowledge_sync", () => {
    function registerProvider(): void {
      registry.register(
        providerTool("wiki_list_pages", () => ({
          results: [
            {
              id: "1",
              title: "Runbook",
              archived: false,
              version: { number: 3, when: "2026-01-01T00:00:00.000Z" },
              _links: { webui: "https://wiki.example/1" },
            },
          ],
        }))
      );
      registry.register(
        providerTool("wiki_get_restrictions", () => ({
          results: [{ type: "known", accountId: "acct-1" }],
        }))
      );
      registry.register(
        providerTool("wiki_get_page", () => ({
          id: "1",
          title: "Runbook",
          body: { storage: { value: "how to restart" } },
          version: { number: 3 },
        }))
      );
    }

    it("indexes a scope and checkpoints only after a clean walk", async () => {
      registerProvider();
      const result = await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: ["ENG"],
        connection_id: "conn-1",
      });
      expect(result).toMatchObject({ success: true });
      expect(sink.emissions.length).toBe(1);
      expect(sink.emissions[0]?.sourceId).toBe("wiki:conn-1/1");
      expect(sink.emissions[0]).toMatchObject({
        externalTenantId: "conn-1",
        locator: {
          integrationId: "wiki",
          integrationMajorVersion: 2,
          connectionId: "conn-1",
          itemId: "1",
          sourceUrl: "https://wiki.example/1",
        },
        provenance: { connectionId: "conn-1" },
      });
      expect(checkpoints.saved.length).toBe(1);
    });

    it("reports refused provider retry without changing the Knowledge checkpoint", async () => {
      const previous: OimKnowledgeCheckpoint = {
        integrationId: "wiki",
        scopeKey: "space:ENG",
        cursor: "previous-page",
        updatedAt: "2025-12-31T00:00:00.000Z",
      };
      checkpoints.seed(previous);
      const calls: RequestContext[] = [];
      registry.register({
        name: "wiki_list_pages",
        tier: "integration",
        mutating: false,
        description: "wiki_list_pages",
        inputSchema: { type: "object" },
        execute: async (_args, callCtx) => {
          calls.push(callCtx);
          return {
            success: false,
            error: {
              code: "retry_wait_unavailable",
              message: "provider requested a delayed retry",
            },
          };
        },
      });

      const result = await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: ["ENG"],
        connection_id: "conn-1",
      });

      expect(result).toMatchObject({
        success: true,
        data: { failures: [{ code: "retry_required", scope: "ENG" }] },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.retryWaitPolicy).toBe("refuse");
      expect(checkpoints.saved).toHaveLength(0);
      expect(await checkpoints.load("wiki", "space:ENG")).toEqual(previous);
      expect(sink.emissions).toHaveLength(0);
    });

    it("routes Knowledge Hooks through the verified API bridge before mapping", async () => {
      const manifest = knowledgeManifestFixture();
      integrations = [
        integration({
          oimManifest: {
            ...manifest,
            profiles: { ...manifest.profiles, hooks: "1.0" },
            hooks: [
              { kind: "acl_map", file: "hooks/runtime.js", export: "mapAcl" },
              { kind: "content_map", file: "hooks/runtime.js", export: "mapContent" },
            ],
          },
        }),
      ];
      registerProvider();
      const bridge = vi.fn(async (hook: OimHook, _value: unknown) =>
        hook.kind === "acl_map"
          ? { results: [{ type: "known", accountId: "acct-1" }] }
          : {
              id: "1",
              title: "Runbook",
              body: { storage: { value: "verified Hook content" } },
              version: { number: 3 },
            }
      );
      const hookRunnerFor = vi.fn(async () => ({ run: bridge }) as unknown as OimHookPhaseRunner);
      oimRuntimeHost = {
        authorizeIntegration: async () => {},
        hookRunnerFor,
      };

      const result = await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: ["ENG"],
        connection_id: "conn-1",
      });

      expect(hookRunnerFor).toHaveBeenCalledWith({
        businessId: "b1",
        integrationId: "wiki",
        integrationMajorVersion: 2,
        manifest: integrations[0]?.oimManifest,
      });
      expect(bridge).toHaveBeenCalledTimes(2);
      expect(bridge.mock.calls.map(([hook]) => hook.kind)).toEqual(["acl_map", "content_map"]);
      expect(bridge.mock.calls[0]?.[1]).toMatchObject({
        operationId: "get-restrictions",
        itemId: "1",
        scopeId: "ENG",
      });
      expect(bridge.mock.calls[1]?.[1]).toMatchObject({
        operationId: "get-page",
        itemId: "1",
      });
      expect(result).toMatchObject({ success: true, data: { indexed: 1, failures: [] } });
      expect(sink.chunks[0]?.text).toBe("verified Hook content");
    });

    it("uses explicit Connection B for every provider call instead of default A", async () => {
      const selected: (string | undefined)[] = [];
      links = { linkedPrincipal: async () => undefined };
      emails = { principalForEmail: async () => ({ kind: "user", id: "u1" }) };
      verifiedEmailDomains = ["example.com"];
      registry.register(
        providerTool("wiki_list_pages", (args) => {
          selected.push(typeof args.connection_id === "string" ? args.connection_id : "conn-a");
          return {
            results: [
              {
                id: "1",
                archived: false,
                version: { number: 3 },
              },
            ],
          };
        })
      );
      registry.register(
        providerTool("wiki_get_restrictions", (args) => {
          selected.push(typeof args.connection_id === "string" ? args.connection_id : "conn-a");
          return { results: [{ type: "known", accountId: "acct-1" }] };
        })
      );
      registry.register(
        providerTool("wiki_get_user", (args) => {
          selected.push(typeof args.connection_id === "string" ? args.connection_id : "conn-a");
          return {
            accountId: "acct-1",
            email: "muskan@example.com",
            emailVerified: true,
          };
        })
      );
      registry.register(
        providerTool("wiki_get_page", (args) => {
          selected.push(typeof args.connection_id === "string" ? args.connection_id : "conn-a");
          return {
            body: { storage: { value: "from connection B" } },
            version: { number: 3 },
          };
        })
      );

      await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: ["ENG"],
        connection_id: "conn-b",
      });

      expect(selected).toEqual(["conn-b", "conn-b", "conn-b", "conn-b"]);
      expect(sink.emissions[0]).toMatchObject({
        sourceId: "wiki:conn-b/1",
        externalTenantId: "conn-b",
        locator: { connectionId: "conn-b" },
        provenance: { connectionId: "conn-b" },
      });
    });

    it("requires a Connection rather than choosing one", async () => {
      registerProvider();
      const result = await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: ["ENG"],
      });
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    });

    it("requires at least one scope", async () => {
      registerProvider();
      const result = await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: [],
        connection_id: "conn-1",
      });
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    });

    it("rejects caller-supplied tenant attribution", async () => {
      registerProvider();
      const result = await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: ["ENG"],
        connection_id: "conn-1",
        external_tenant_id: "wrong-tenant",
      });
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    });

    it("records a failure for a scope whose list Tool is missing, without emitting", async () => {
      const result = await run("integration_knowledge_sync", {
        integration: SLUG,
        source_kind: "space",
        scopes: ["ENG"],
        connection_id: "conn-1",
      });
      expect(result.success).toBe(true);
      const data = (result as { data: { failures: unknown[]; emitted: number } }).data;
      expect(data.emitted).toBe(0);
      expect(data.failures).toHaveLength(1);
      expect(checkpoints.saved).toHaveLength(0);
    });
  });
});
