import type { EgressHttpPort, IntegrationHttpResponse } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import { SecretBroker, type SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, Logger, SoulIntegration } from "@tulipfarm/soul";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const AJV_INVALID_PATTERN_SPEC = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.bad.test/v1" }],
  paths: {
    "/pages/{page_id}": {
      get: {
        operationId: "getPage",
        parameters: [
          { name: "page_id", in: "path", required: true, schema: { type: "string", pattern: "[" } },
        ],
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

function integration(
  slug: string,
  connected: boolean,
  document: unknown = SPEC,
  egress: IntegrationManifest["egress"] = EGRESS
): SoulIntegration {
  return {
    slug,
    sourceIntegration: slug,
    manifest: {
      name: slug,
      version: "1.0.0",
      description: "",
      egress,
    } as IntegrationManifest,
    egressSpec: document,
    ...(connected ? { connection: { enabled: true, env: {} } } : {}),
  } as SoulIntegration;
}

function oimIntegration(): SoulIntegration {
  const oimManifest: OimManifest = {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "twilio",
      name: "Twilio",
      version: "1.0.0",
      description: "Read messages.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "get-message",
        name: "get_message",
        description: "Read one message.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.twilio.test",
          path: "/v1/messages/{message_id}",
          parameters: [{ name: "message_id", in: "path", schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  } as OimManifest;
  return { slug: "twilio", sourceIntegration: "twilio", oimManifest };
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

  it("registers OIM operations before a Connection exists", () => {
    installed = [oimIntegration()];

    expect(sync.sync()).toBe(1);
    expect(names()).toEqual(["twilio_get_message"]);
  });

  it("forwards each lazily created Secret broker to the lease tracker", async () => {
    const releaseBroker = vi.fn();
    const trackConnectionBroker = vi.fn(() => releaseBroker);
    sync = new DeclarativeToolSync({
      registry,
      integrations: () => installed,
      businessId: "biz",
      effects: new MemoryEffectStore(),
      secrets: async () => ({}) as SecretsService,
      http: noopHttp,
      trackConnectionBroker,
    });
    installed = [oimIntegration()];

    expect(sync.sync()).toBe(1);
    expect(trackConnectionBroker).not.toHaveBeenCalled();

    await registry
      .getAll()[0]
      ?.execute({ message_id: "SM1" }, { userId: "user-1", runId: "run-1", toolCallId: "call-1" });

    expect(trackConnectionBroker).toHaveBeenCalledOnce();
    expect(trackConnectionBroker).toHaveBeenCalledWith(expect.any(SecretBroker));
    expect(releaseBroker).toHaveBeenCalledOnce();
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

  it("reports an AJV-invalid Tool without throwing or corrupting tracked registrations", () => {
    const errors: string[] = [];
    const logger = {
      error(message: string) {
        errors.push(message);
      },
    } as unknown as Logger;
    sync = new DeclarativeToolSync({
      registry,
      integrations: () => installed,
      businessId: "biz",
      effects: new MemoryEffectStore(),
      secrets: async () => ({}) as SecretsService,
      http: noopHttp,
      logger: () => logger,
    });
    installed = [
      integration("bad-regex", true, AJV_INVALID_PATTERN_SPEC, {
        ...EGRESS,
        operations: [{ operation: "getPage", name: "read_page", description: "Read one page." }],
      }),
      integration("acme", true),
    ];

    expect(() => sync.sync()).not.toThrow();
    expect(names().sort()).toEqual(["acme_read_page", "acme_search_docs"]);
    expect(sync.countFor("bad-regex")).toBe(0);
    expect(sync.countFor("acme")).toBe(2);
    expect(errors.some((message) => message.includes('Integration "bad-regex"'))).toBe(true);

    installed = [integration("bad-regex", false), integration("acme", false)];
    expect(sync.sync()).toBe(0);
    expect(names()).toEqual([]);
  });

  it("counts only the named integration's Tools", () => {
    installed = [integration("acme", true), integration("globex", true)];
    sync.sync();

    expect(sync.countFor("acme")).toBe(2);
    expect(sync.countFor("globex")).toBe(2);
    expect(sync.countFor("initech")).toBe(0);
  });

  it("counts by owning slug, not by normalized name prefix", () => {
    installed = [integration("google", true), integration("google-docs", true)];
    sync.sync();

    expect(names().sort()).toEqual([
      "google_docs_read_page",
      "google_docs_search_docs",
      "google_read_page",
      "google_search_docs",
    ]);
    expect(sync.countFor("google")).toBe(2);
    expect(sync.countFor("google-docs")).toBe(2);
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
