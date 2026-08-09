import type { EgressHttpPort, IntegrationHttpResponse } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, SoulIntegration } from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../broker/tool-adapter";
import { DeclarativeToolSync } from "./sync";

const SPEC = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.acme.test/v1" }],
  paths: {
    "/search": {
      post: {
        operationId: "search",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/pages/{page_id}": {
      get: {
        operationId: "getPage",
        parameters: [{ name: "page_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
};

const EGRESS: IntegrationManifest["egress"] = {
  type: "openapi",
  spec: "spec.json",
  operations: [
    { operation: "search", name: "search_docs", description: "Search Acme docs." },
    { operation: "getPage", name: "read_page", description: "Read one page." },
  ],
  auth: { token_env: "ACME_TOKEN" },
};

function integration(slug: string, connected: boolean): SoulIntegration {
  return {
    slug,
    sourceIntegration: slug,
    manifest: {
      name: slug,
      version: "1.0.0",
      description: "",
      egress: EGRESS,
    } as IntegrationManifest,
    egressSpec: SPEC,
    ...(connected ? { connection: { enabled: true, env: {} } } : {}),
  } as SoulIntegration;
}

const noopHttp: EgressHttpPort = {
  async send(): Promise<IntegrationHttpResponse> {
    return { status: 200, headers: {}, body: {} };
  },
};

describe("DeclarativeToolSync", () => {
  let registry: ToolRegistry;
  let installed: SoulIntegration[];
  let sync: DeclarativeToolSync;

  beforeEach(() => {
    registry = new ToolRegistry();
    installed = [];
    sync = new DeclarativeToolSync({
      registry,
      integrations: () => installed,
      businessId: "biz",
      effects: new MemoryEffectStore(),
      secrets: async () => ({}) as SecretsService,
      http: noopHttp,
    });
  });

  const names = () => registry.getAll().map((tool) => tool.name);

  it("publishes nothing while an integration is installed but not connected", () => {
    installed = [integration("acme", false)];
    expect(sync.sync()).toBe(0);
    expect(names()).toEqual([]);
  });

  it("registers a connected integration's operations", () => {
    installed = [integration("acme", true)];
    expect(sync.sync()).toBe(2);
    expect(names().sort()).toEqual(["acme_read_page", "acme_search_docs"]);
  });

  it("unregisters the Tools when the integration disconnects", () => {
    installed = [integration("acme", true)];
    sync.sync();
    installed = [integration("acme", false)];

    expect(sync.sync()).toBe(0);
    expect(names()).toEqual([]);
  });

  it("unregisters the Tools when the integration is removed entirely", () => {
    installed = [integration("acme", true)];
    sync.sync();
    installed = [];

    expect(sync.sync()).toBe(0);
    expect(names()).toEqual([]);
  });

  it("re-registers on reconnect", () => {
    installed = [integration("acme", true)];
    sync.sync();
    installed = [integration("acme", false)];
    sync.sync();
    installed = [integration("acme", true)];

    expect(sync.sync()).toBe(2);
    expect(names().sort()).toEqual(["acme_read_page", "acme_search_docs"]);
  });

  it("leaves Tools it did not register alone", () => {
    registry.register({
      name: "memory_read",
      description: "platform tool",
      tier: "platform",
      mutating: false,
      inputSchema: { type: "object" },
      execute: async () => ({ success: true as const, data: {} }),
    });
    installed = [integration("acme", true)];
    sync.sync();
    installed = [];
    sync.sync();

    expect(names()).toEqual(["memory_read"]);
  });

  it("disconnecting one integration leaves another's Tools registered", () => {
    installed = [integration("acme", true), integration("globex", true)];
    expect(sync.sync()).toBe(4);

    installed = [integration("acme", true), integration("globex", false)];
    expect(sync.sync()).toBe(2);
    expect(names().sort()).toEqual(["acme_read_page", "acme_search_docs"]);
  });

  it("counts only the named integration's Tools", () => {
    installed = [integration("acme", true), integration("globex", true)];
    sync.sync();

    expect(sync.countFor("acme")).toBe(2);
    expect(sync.countFor("globex")).toBe(2);
    expect(sync.countFor("initech")).toBe(0);
  });

  it("reports zero for an integration whose Tools were just revoked", () => {
    installed = [integration("acme", true)];
    sync.sync();
    installed = [integration("acme", false)];
    sync.sync();

    expect(sync.countFor("acme")).toBe(0);
  });

  it("is idempotent", () => {
    installed = [integration("acme", true)];
    sync.sync();

    expect(sync.sync()).toBe(2);
    expect(names().sort()).toEqual(["acme_read_page", "acme_search_docs"]);
  });
});
