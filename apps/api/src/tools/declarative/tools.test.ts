import type { EgressHttpPort, EgressHttpRequest } from "@tulipfarm/integrations";
import { compileOpenApiEgress } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, SoulIntegration } from "@tulipfarm/soul";
import { MemoryEffectStore, toolContractSpecOf } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { ToolRegistry } from "../../broker/tool-adapter";
import { executeToolBinding } from "../../ingress/bindings";
import type { RequestContext } from "../types";
import {
  buildDeclarativeTools,
  declarativeToolName,
  egressSecretRef,
  principalEgressSecretRef,
} from "./tools";

const SPEC = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.acme.test/v1" }],
  paths: {
    "/search": {
      post: {
        operationId: "search",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
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

const SEARCH_OP = { operation: "search", name: "search_docs", description: "Search Acme docs." };
const READ_OP = { operation: "getPage", name: "read_page", description: "Read one page." };

function integration(
  egress: IntegrationManifest["egress"],
  slug = "acme",
  document: unknown = SPEC,
  manifestName = slug
): SoulIntegration {
  return {
    slug,
    sourceIntegration: manifestName,
    manifest: {
      name: manifestName,
      version: "1.0.0",
      description: "",
      egress,
    } as IntegrationManifest,
    egressSpec: document,
  };
}

function openApiEgress(
  overrides: Partial<Extract<IntegrationManifest["egress"], { type: "openapi" }>> = {}
): IntegrationManifest["egress"] {
  return {
    type: "openapi",
    spec: "spec.json",
    operations: [SEARCH_OP, READ_OP],
    auth: { token_env: "ACME_TOKEN" },
    ...overrides,
  };
}

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];
  status = 200;
  body: unknown = { ok: true };

  async send(request: EgressHttpRequest) {
    this.sent.push(request);
    return { status: this.status, headers: {}, body: this.body };
  }
}

function secretsStub(values: Record<string, string>): () => Promise<SecretsService> {
  const service = {
    get: async (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`no secret ${key}`);
      return value;
    },
  };
  return async () => service as unknown as SecretsService;
}

function deps(http: RecordingHttp, values: Record<string, string> = {}) {
  return {
    businessId: "biz-1",
    effects: new MemoryEffectStore(),
    secrets: secretsStub(values),
    http,
  };
}

const CTX: RequestContext = { userId: "u1", runId: "run-1", toolCallId: "call-1" };

const CONNECTED_SECRETS = { "integration.acme.ACME_TOKEN": "tok-live" };

describe("buildDeclarativeTools", () => {
  it("publishes one namespaced Tool per declared operation", () => {
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress())],
      deps(new RecordingHttp())
    );

    expect(tools.map((tool) => tool.name)).toEqual(["acme_search_docs", "acme_read_page"]);
  });

  it("namespaces by slug so two integrations may publish the same tool name", () => {
    const { tools } = buildDeclarativeTools(
      [
        integration(openApiEgress({ operations: [SEARCH_OP] })),
        integration(openApiEgress({ operations: [SEARCH_OP] }), "globex"),
      ],
      deps(new RecordingHttp())
    );

    expect(tools.map((tool) => tool.name)).toEqual(["acme_search_docs", "globex_search_docs"]);
  });

  it("publishes nothing for an integration with no openapi egress", () => {
    const { tools, problems } = buildDeclarativeTools(
      [integration({ type: "none" })],
      deps(new RecordingHttp())
    );

    expect(tools).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("marks a write mutating and a read not, so approval gating applies to the right ones", () => {
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress())],
      deps(new RecordingHttp())
    );

    expect(tools.find((t) => t.name === "acme_search_docs")?.mutating).toBe(true);
    expect(tools.find((t) => t.name === "acme_read_page")?.mutating).toBe(false);
    expect(tools.every((tool) => tool.tier === "integration")).toBe(true);
  });

  it("calls the provider with the leased credential", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress())],
      deps(http, CONNECTED_SECRETS)
    );

    const result = await tools
      .find((tool) => tool.name === "acme_read_page")
      ?.execute({ page_id: "p1" }, CTX);

    expect(result).toEqual({ success: true, data: { ok: true } });
    expect(http.sent[0]?.url).toBe("https://api.acme.test/v1/pages/p1");
    expect(http.sent[0]?.headers.Authorization).toBe("Bearer tok-live");
  });

  it("reports a clear reason instead of calling when the credential is not stored yet", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools([integration(openApiEgress())], deps(http));

    const result = await tools[1]?.execute({ page_id: "p1" }, CTX);

    expect(result).toMatchObject({ success: false });
    expect(http.sent).toHaveLength(0);
  });

  it("refuses to lease another integration's credential", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [
        integration(openApiEgress({ operations: [READ_OP] })),
        integration(openApiEgress({ operations: [READ_OP] }), "globex"),
      ],
      deps(http, { ...CONNECTED_SECRETS, "integration.globex.ACME_TOKEN": "tok-globex" })
    );

    await tools.find((t) => t.name === "acme_read_page")?.execute({ page_id: "p1" }, CTX);
    await tools.find((t) => t.name === "globex_read_page")?.execute({ page_id: "p1" }, CTX);

    expect(http.sent[0]?.headers.Authorization).toBe("Bearer tok-live");
    expect(http.sent[1]?.headers.Authorization).toBe("Bearer tok-globex");
  });

  it("does not repeat a call already recorded against the same run and call id", async () => {
    const http = new RecordingHttp();
    const shared = deps(http, CONNECTED_SECRETS);
    const { tools } = buildDeclarativeTools([integration(openApiEgress())], shared);
    const tool = tools.find((t) => t.name === "acme_search_docs");

    const first = await tool?.execute({ body: { q: "x" } }, CTX);
    const second = await tool?.execute({ body: { q: "x" } }, CTX);

    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true, data: { replayed: true } });
    expect(http.sent).toHaveLength(1);
  });

  it("treats a different tool call in the same run as a new effect", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress())],
      deps(http, CONNECTED_SECRETS)
    );
    const tool = tools.find((t) => t.name === "acme_search_docs");

    await tool?.execute({ body: { q: "x" } }, CTX);
    await tool?.execute({ body: { q: "y" } }, { ...CTX, toolCallId: "call-2" });

    expect(http.sent).toHaveLength(2);
  });

  it("refuses to run outside a Run, where no effect could be recorded", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress())],
      deps(http, CONNECTED_SECRETS)
    );

    const result = await tools[0]?.execute({ body: {} }, { userId: "u1" });

    expect(result).toMatchObject({ success: false });
    expect(http.sent).toHaveLength(0);
  });

  it("surfaces a provider rejection as a failed call rather than throwing", async () => {
    const http = new RecordingHttp();
    http.status = 401;
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress())],
      deps(http, CONNECTED_SECRETS)
    );

    const result = await tools
      .find((t) => t.name === "acme_read_page")
      ?.execute({ page_id: "p1" }, CTX);

    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain("reconnect");
  });

  it("reports a malformed manifest instead of silently publishing nothing", () => {
    const { tools, problems } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [{ ...SEARCH_OP, operation: "nope" }] }))],
      deps(new RecordingHttp())
    );

    expect(tools).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("acme");
    expect(problems[0]).toContain("operation_not_found");
  });

  it("keeps publishing other integrations when one manifest is broken", () => {
    const { tools, problems } = buildDeclarativeTools(
      [
        integration(openApiEgress({ operations: [{ ...SEARCH_OP, operation: "nope" }] })),
        integration(openApiEgress({ operations: [READ_OP] }), "globex"),
      ],
      deps(new RecordingHttp())
    );

    expect(tools.map((tool) => tool.name)).toEqual(["globex_read_page"]);
    expect(problems).toHaveLength(1);
  });

  it("keeps publishing other integrations when a leading digit slug has a problem", () => {
    const { tools, problems } = buildDeclarativeTools(
      [
        integration(openApiEgress({ operations: [READ_OP, READ_OP] }), "1password"),
        integration(openApiEgress({ operations: [READ_OP] }), "globex"),
      ],
      deps(new RecordingHttp())
    );

    expect(tools.map((tool) => tool.name)).toEqual(["globex_read_page"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Integration "1password" published no Tools');
  });

  it("registers a leading digit slug under a valid lower_snake name", () => {
    const { tools, problems } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }), "1password")],
      deps(new RecordingHttp())
    );

    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(["i_1password_read_page"]);
  });

  it("uses one authoritative name for a hyphenated slug", () => {
    const { tools, problems } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }), "google-docs")],
      deps(new RecordingHttp())
    );
    const tool = tools[0];

    expect(problems).toEqual([]);
    expect(tool?.name).toBe("google_docs_read_page");
    if (tool?.definition === undefined) throw new Error("expected declarative tool definition");
    expect(tool.definition.name).toBe(tool.name);
    const compiled = compileOpenApiEgress({
      slug: "google-docs",
      egress: openApiEgress({ operations: [READ_OP] }),
      document: SPEC,
    });
    expect(tool.definition.authorization.action).toBe(compiled[0]?.contract.spec.action);
    expect(toolContractSpecOf(tool.definition)).toMatchObject({
      toolId: tool.name,
      action: compiled[0]?.contract.spec.action,
    });
  });

  it("allows matching namespaces when the full tool names do not collide", () => {
    const { tools, problems } = buildDeclarativeTools(
      [
        integration(openApiEgress({ operations: [READ_OP] }), "google-docs"),
        integration(openApiEgress({ operations: [SEARCH_OP] }), "google.docs"),
      ],
      deps(new RecordingHttp())
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "google_docs_read_page",
      "google_docs_search_docs",
    ]);
    expect(problems).toEqual([]);
  });

  it("reports a full tool name collision without overwriting the first integration", () => {
    const { tools, problems } = buildDeclarativeTools(
      [
        integration(openApiEgress({ operations: [READ_OP] }), "google-docs"),
        integration(
          openApiEgress({ operations: [{ ...READ_OP, name: "docs_read_page" }] }),
          "google"
        ),
      ],
      deps(new RecordingHttp())
    );

    expect(tools.map((tool) => tool.name)).toEqual(["google_docs_read_page"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Integration "google" skipped Tool "google_docs_read_page"');
    expect(problems[0]).toContain('collides with integration "google-docs"');
  });

  it("does not fabricate authorization targets from booleans", () => {
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }))],
      deps(new RecordingHttp())
    );
    const definition = tools[0]?.definition;
    if (definition === undefined) throw new Error("expected declarative tool definition");

    expect(definition.targetsFor({ page_id: true, body: { parent: { page_id: false } } })).toEqual(
      []
    );
    expect(definition.targetsFor({ page_id: 123 })).toEqual([
      { type: "integration.acme", id: "page:123" },
    ]);
  });

  it("reads the credential the connect flow sealed under the install slug, not the manifest name", async () => {
    // A second install of the same integration gets its own slug and its own credential
    // (`SoulIntegration.slug` is user-assigned and may differ from `manifest.name`). Keying off the
    // manifest name would have every instance share the first one's token.
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }), "acme-eu", SPEC, "acme")],
      deps(http, { "integration.acme-eu.ACME_TOKEN": "tok-eu", ...CONNECTED_SECRETS })
    );

    const result = await tools[0]?.execute({ page_id: "p1" }, CTX);

    if (!result.success) throw new Error(JSON.stringify(result.error));
    expect(http.sent[0]?.headers.Authorization).toBe("Bearer tok-eu");
  });

  it("leases the caller's own credential when the turn resolved a credential principal", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }))],
      deps(http, {
        ...CONNECTED_SECRETS,
        "principal.user.u1.acme.ACME_TOKEN": "tok-personal",
      })
    );

    const result = await tools[0]?.execute(
      { page_id: "p1" },
      { ...CTX, credentialPrincipal: { kind: "user", id: "u1" } }
    );

    expect(result).toEqual({ success: true, data: { ok: true } });
  });

  it("refuses rather than falling back to the business credential when the person has none", async () => {
    // The whole point of acting as a person is that the provider gets to apply its own ACLs to
    // them. Silently spending the shared bot credential here would hand back a result the person
    // was never entitled to, and the gate upstream would believe a personal credential was used.
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }))],
      deps(http, CONNECTED_SECRETS)
    );

    const result = await tools[0]?.execute(
      { page_id: "p1" },
      { ...CTX, credentialPrincipal: { kind: "user", id: "u1" } }
    );

    expect(result.success).toBe(false);
    expect(http.sent).toHaveLength(0);
  });

  it("does not let one person's stored credential serve another person's call", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }))],
      deps(http, {
        ...CONNECTED_SECRETS,
        "principal.user.u1.acme.ACME_TOKEN": "tok-personal",
      })
    );

    const result = await tools[0]?.execute(
      { page_id: "p1" },
      { ...CTX, credentialPrincipal: { kind: "user", id: "u2" } }
    );

    expect(result.success).toBe(false);
    expect(http.sent).toHaveLength(0);
  });

  it("names secrets the same way the connect flow sealed them", () => {
    expect(egressSecretRef("acme", "ACME_TOKEN")).toBe(
      "secret://integrations/acme/egress/ACME_TOKEN"
    );
    expect(principalEgressSecretRef("acme", "ACME_TOKEN", { kind: "user", id: "u1" })).toBe(
      "secret://integrations/acme/egress/ACME_TOKEN/principal/user/u1"
    );
    expect(declarativeToolName("acme", "search_docs")).toBe("acme_search_docs");
    expect(declarativeToolName("google-docs", "read_page")).toBe("google_docs_read_page");
    expect(declarativeToolName("1password", "read_page")).toBe("i_1password_read_page");
  });
});

/*
 * The two halves of a manifest-driven channel: `egress` publishes the tools and `ingress.chat.reply`
 * binds to them by name. Nothing forced those names to agree — ingress resolved
 * `integration_{slug}_{tool}` while egress registered `{slug}_{tool}`, so every reply binding
 * returned `not_found` and a declarative channel could receive messages but never answer. Both
 * sides' own unit tests passed throughout, because each spelled the name it expected.
 */
describe("egress tools resolve through ingress reply bindings", () => {
  it("an ingress binding executes the tool the manifest's egress published", async () => {
    const http = new RecordingHttp();
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress())],
      deps(http, CONNECTED_SECRETS)
    );
    const registry = { getAll: () => tools } as unknown as ToolRegistry;

    const result = await executeToolBinding(
      registry,
      "acme",
      { tool: "read_page", args: { page_id: "{page}" } },
      { page: "p-42" },
      { runId: "run-1", toolCallId: "ingress-reply:1:default" }
    );

    expect("error" in result ? result.error : undefined).toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(http.sent).toHaveLength(1);
    expect(http.sent[0]?.url).toContain("/pages/p-42");
  });

  it("uses the same normalized name for hyphenated egress and ingress bindings", async () => {
    const http = new RecordingHttp();
    const shared = deps(http, { "integration.google-docs.ACME_TOKEN": "tok-docs" });
    const { tools } = buildDeclarativeTools(
      [integration(openApiEgress({ operations: [READ_OP] }), "google-docs")],
      shared
    );
    const registry = { getAll: () => tools } as unknown as ToolRegistry;

    const result = await executeToolBinding(
      registry,
      "google-docs",
      { tool: "read_page", args: { page_id: "{page}" } },
      { page: "doc-1" },
      { runId: "run-1", toolCallId: "ingress-reply:google-docs:1" }
    );

    expect(tools.map((tool) => tool.name)).toEqual(["google_docs_read_page"]);
    expect(result).toMatchObject({ success: true });
    expect(http.sent[0]?.url).toContain("/pages/doc-1");
    expect((await shared.effects.list("biz-1"))[0]?.intent.toolId).toBe(
      "openapi.google-docs.read_page"
    );
  });
});
