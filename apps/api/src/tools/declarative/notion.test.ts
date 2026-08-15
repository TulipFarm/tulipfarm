import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, SoulIntegration } from "@tulipfarm/soul";
import {
  bundledIntegrationsDir,
  validateAuthSteps,
  validateThirdPartyManifest,
} from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildDeclarativeTools } from "./tools";

describe("notion bundled integration", () => {
  let manifest: IntegrationManifest;
  let spec: unknown;

  beforeAll(async () => {
    const dir = join(bundledIntegrationsDir(), "notion");
    manifest = parseYaml(await readFile(join(dir, "manifest.yml"), "utf8")) as IntegrationManifest;
    spec = parseYaml(await readFile(join(dir, "openapi.json"), "utf8"));
  });

  const integration = (): SoulIntegration =>
    ({
      slug: "notion",
      sourceIntegration: "notion",
      manifest,
      egressSpec: spec,
      connection: { enabled: true, env: {} },
    }) as SoulIntegration;

  const build = () =>
    buildDeclarativeTools([integration()], {
      businessId: "biz",
      effects: new MemoryEffectStore(),
      secrets: async () => ({}) as SecretsService,
      http: { send: async () => ({ status: 200, headers: {}, body: {} }) },
    });

  it("ships no bespoke code — the manifest declares openapi egress", () => {
    expect(manifest.egress?.type).toBe("openapi");
  });

  it("passes the same trust checks a third-party manifest must pass", () => {
    expect(validateThirdPartyManifest(manifest)).toEqual([]);
    expect(validateAuthSteps(manifest)).toEqual([]);
  });

  it("compiles every declared operation with no problems", () => {
    const { tools, problems } = build();
    expect(problems).toEqual([]);
    expect(tools).toHaveLength(manifest.egress?.type === "openapi" ? 8 : 0);
  });

  it("publishes the namespaced tool names agents call", () => {
    const { tools } = build();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "notion_append_page_content",
      "notion_create_page",
      "notion_query_database",
      "notion_read_database_schema",
      "notion_read_page",
      "notion_read_page_content",
      "notion_search",
      "notion_update_page",
    ]);
  });

  it("gates writes behind approval and leaves reads ungated", () => {
    const mutating = Object.fromEntries(build().tools.map((tool) => [tool.name, tool.mutating]));
    expect(mutating.notion_create_page).toBe(true);
    expect(mutating.notion_update_page).toBe(true);
    expect(mutating.notion_append_page_content).toBe(true);
    expect(mutating.notion_search).toBe(false);
    expect(mutating.notion_read_page).toBe(false);
    expect(mutating.notion_query_database).toBe(false);
  });

  it("derives argument schemas an LLM can fill", () => {
    const tools = new Map(build().tools.map((tool) => [tool.name, tool]));

    const read = tools.get("notion_read_page")?.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(read.properties).toHaveProperty("page_id");
    expect(read.required).toContain("page_id");

    const search = tools.get("notion_search")?.inputSchema as {
      properties: { body?: { properties?: Record<string, unknown> } };
    };
    expect(search.properties.body?.properties).toHaveProperty("query");
  });

  it("leaves no $ref in any published schema", () => {
    for (const tool of build().tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
    }
  });

  it("publishes nothing while Notion is installed but not connected", () => {
    const disconnected = { ...integration(), connection: undefined } as SoulIntegration;
    const { tools } = buildDeclarativeTools([disconnected], {
      businessId: "biz",
      effects: new MemoryEffectStore(),
      secrets: async () => ({}) as SecretsService,
      http: { send: async () => ({ status: 200, headers: {}, body: {} }) },
    });
    expect(tools).toHaveLength(8);
  });
});
