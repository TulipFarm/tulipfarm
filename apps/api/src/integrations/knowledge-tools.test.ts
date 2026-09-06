import type {
  KnowledgeChunkEmission,
  KnowledgeSourceEmission,
  OimKnowledgeCheckpoint,
} from "@tulipfarm/integrations";
import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { RequestContext } from "@tulipfarm/tool-host";
import { toToolDef } from "@tulipfarm/tool-host";
import { beforeEach, describe, expect, it } from "vitest";
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
    connection: { enabled: true },
    ...overrides,
  } as SoulIntegration;
}

/** A stand-in for a registered declarative Tool, so the port under test dispatches for real. */
function providerTool(
  name: string,
  respond: (args: Record<string, unknown>) => unknown
): ReturnType<typeof toToolDef> {
  return {
    name,
    tier: "integration",
    mutating: false,
    description: name,
    inputSchema: { type: "object" },
    execute: async (args) => ({
      success: true,
      data: respond((args ?? {}) as Record<string, unknown>),
    }),
  } as ReturnType<typeof toToolDef>;
}

class MemoryCheckpoints {
  readonly saved: OimKnowledgeCheckpoint[] = [];
  private readonly rows = new Map<string, OimKnowledgeCheckpoint>();
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

  function context(): IntegrationKnowledgeToolContext {
    return {
      businessId: "b1",
      integrations: () => integrations,
      registry,
      checkpoints,
      sink,
      links: { linkedPrincipal: async () => ({ kind: "user", id: "u1" }) },
      policy: { verifiedEmailDomains: [] },
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

    it("refuses an Integration that is installed but not connected", async () => {
      integrations = [integration({ connection: { enabled: false } } as Partial<SoulIntegration>)];
      const result = await run("integration_knowledge_profile", { integration: SLUG });
      expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
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
      });
      expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    });

    it("reports the Tool being unavailable rather than indexing nothing silently", async () => {
      const result = await run("integration_knowledge_scopes", {
        integration: SLUG,
        source_kind: "space",
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
      expect(checkpoints.saved.length).toBe(1);
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
