/**
 * Core 1.1 operation shapes, proved from manifest to wire.
 *
 * Each case compiles a real manifest and dispatches through the real adapter, because every one of
 * these mechanisms is a *pair* — a compiler decision and a dispatch decision — and a test that
 * exercised only one half would pass while the two disagreed.
 */

import type { OimManifest } from "@tulipfarm/schema";
import { oimManifestIssues, validateOimManifest } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import { compileOimHttpOperations } from "./oim-http-compile";
import { NEXT_PAGE_TOKEN_PROPERTY, PAGE_TOKEN_ARGUMENT } from "./oim-pagination";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private responses: IntegrationHttpResponse[]) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.sent.push(request);
    return this.responses[
      Math.min(this.sent.length - 1, this.responses.length - 1)
    ] as IntegrationHttpResponse;
  }
}

function manifest(overrides: {
  readonly id: string;
  readonly operation: Record<string, unknown>;
  readonly configurationFields?: readonly Record<string, unknown>[];
  readonly credentialSlots?: readonly Record<string, unknown>[];
}): OimManifest {
  return checked({
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: overrides.id,
      name: overrides.id,
      version: "1.0.0",
      description: `A ${overrides.id} package used to prove one Core 1.1 mechanism end to end.`,
      license: "Apache-2.0",
      maintainers: [{ name: "TulipFarm", url: "https://tulipfarm.dev" }],
    },
    profiles: { core: "1.1", auth: "1.0" },
    auth: {
      credentialSlots: overrides.credentialSlots ?? [
        { id: "token", label: "Token", kind: "api_key", required: true },
      ],
      ...(overrides.configurationFields === undefined
        ? {}
        : { configurationFields: overrides.configurationFields }),
      steps: [
        {
          id: "token",
          type: "fields",
          title: "Paste the token",
          fields: [
            {
              id: "token",
              label: "Token",
              input: "password",
              required: true,
              target: { type: "credential", slot: "token" },
            },
          ],
        },
      ],
    },
    operations: [overrides.operation],
  });
}

/** Structural validation plus the semantic pass, which is what an installed package goes through. */
function checked(document: unknown): OimManifest {
  const manifest = validateOimManifest(document);
  const issues = oimManifestIssues(manifest);
  if (issues.length > 0) throw new Error(issues.join("; "));
  return manifest;
}

function request(args: Readonly<Record<string, unknown>>): ToolAdapterRequest {
  return {
    intent: {
      intentId: "intent-1",
      businessId: "business-1",
      runId: "run-1",
      stateId: "state-1",
      toolId: "tool-1",
      toolVersion: "1.0.0",
      action: "integration.test.op",
      targetRefs: [],
      arguments: args,
      idempotencyKey: "effect-1",
    },
    idempotencyKey: "effect-1",
    attempt: 1,
  };
}

const okResponse: IntegrationHttpResponse = { status: 200, headers: {}, body: { ok: true } };

function inputProperties(
  tool: ReturnType<typeof compileOimHttpOperations>[number] | undefined
): Record<string, unknown> {
  if (tool === undefined) throw new Error("no tool compiled");
  return (tool.contract.spec.inputSchema as { properties: Record<string, unknown> }).properties;
}

describe("Core 1.1 — a credential in the path", () => {
  const compiled = () =>
    compileOimHttpOperations(
      manifest({
        id: "pathcred",
        operation: {
          id: "get-me",
          name: "pathcred_get_me",
          description: "Identify the bot behind this token.",
          effect: "read",
          identityMode: "shared_only",
          credentialSlot: "token",
          credentialInjection: { in: "path", format: "bot{token}" },
          source: {
            type: "http",
            method: "GET",
            baseUrl: "https://api.telegram.example",
            path: "/{credential}/getMe",
          },
          response: { maxBytes: 4096, schema: { type: "object" } },
        },
      })
    )[0];

  it("never puts the credential in the compiled Tool's destination or path", () => {
    const tool = compiled();
    expect(tool?.contract.spec.allowedDestinations).toEqual(["api.telegram.example"]);
    // The binding is logged and inspected, so the secret must not be resolvable from it.
    expect(tool?.binding.pathTemplate).toBe("/{credential}/getMe");
    expect(JSON.stringify(tool?.contract)).not.toContain("secret-token");
  });

  it("substitutes it at dispatch, formatted, and never percent-encoded", async () => {
    const http = new RecordingHttp([okResponse]);
    const tool = compiled();
    if (tool === undefined) throw new Error("no tool compiled");
    await new OimHttpToolAdapter({ http, binding: tool.binding }).dispatch(
      request({}),
      "123456789:AAExampleToken"
    );
    expect(http.sent[0]?.url).toBe(
      "https://api.telegram.example/bot123456789:AAExampleToken/getMe"
    );
  });

  it("refuses a credential that is not a clean path segment rather than mangling it", async () => {
    const http = new RecordingHttp([okResponse]);
    const tool = compiled();
    if (tool === undefined) throw new Error("no tool compiled");
    await expect(
      new OimHttpToolAdapter({ http, binding: tool.binding }).dispatch(request({}), "a/b")
    ).rejects.toThrow(/credential_invalid/);
    expect(http.sent).toEqual([]);
  });
});

describe("Core 1.1 — two credential slots", () => {
  const compiled = () =>
    compileOimHttpOperations(
      manifest({
        id: "trello",
        credentialSlots: [
          { id: "api_key", label: "API key", kind: "api_key", required: true },
          { id: "token", label: "Token", kind: "bearer_token", required: true },
        ],
        operation: {
          id: "get-member",
          name: "trello_get_member",
          description: "Read the current Trello member.",
          effect: "read",
          identityMode: "shared_only",
          credentialSlot: "api_key",
          credentialInjection: { in: "query", name: "key", format: "{token}" },
          secondaryCredential: {
            slot: "token",
            injection: { in: "query", name: "token", format: "{token}" },
          },
          source: {
            type: "http",
            method: "GET",
            baseUrl: "https://api.trello.example",
            path: "/1/members/me",
          },
          response: { maxBytes: 4096, schema: { type: "object" } },
        },
      })
    )[0];

  it("injects both slot-bound credentials into their distinct locations", async () => {
    const http = new RecordingHttp([okResponse]);
    const tool = compiled();
    if (tool === undefined) throw new Error("no tool compiled");

    await new OimHttpToolAdapter({ http, binding: tool.binding }).dispatch(
      request({}),
      "key-live",
      { api_key: "key-live", token: "token-live" }
    );

    expect(http.sent[0]?.url).toBe(
      "https://api.trello.example/1/members/me?key=key-live&token=token-live"
    );
  });
});

describe("Core 1.1 — a pinned parameter", () => {
  const compiled = () =>
    compileOimHttpOperations(
      manifest({
        id: "pinned",
        operation: {
          id: "search",
          name: "pinned_search",
          description: "Search, at a version this package pins.",
          effect: "read",
          identityMode: "shared_only",
          credentialSlot: "token",
          credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
          source: {
            type: "http",
            method: "GET",
            baseUrl: "https://api.notion.example",
            path: "/v1/search",
            parameters: [
              { name: "query", in: "query", schema: { type: "string" } },
              { name: "Notion-Version", in: "header", value: "2022-06-28", schema: {} },
              { name: "archived", in: "query", value: "false", schema: {} },
            ],
          },
          response: { maxBytes: 4096, schema: { type: "object" } },
        },
      })
    )[0];

  it("is absent from the published Tool schema", () => {
    expect(Object.keys(inputProperties(compiled())).sort()).toEqual(["query"]);
  });

  it("is present on the wire, and an argument cannot shadow it", async () => {
    const http = new RecordingHttp([okResponse]);
    const tool = compiled();
    if (tool === undefined) throw new Error("no tool compiled");
    await new OimHttpToolAdapter({ http, binding: tool.binding }).dispatch(
      // A model that guesses the pinned names anyway gets them ignored, not honoured.
      request({ query: "roadmap", archived: "true", "Notion-Version": "2000-01-01" }),
      "secret-token"
    );
    expect(http.sent[0]?.url).toBe(
      "https://api.notion.example/v1/search?query=roadmap&archived=false"
    );
    expect(http.sent[0]?.headers["Notion-Version"]).toBe("2022-06-28");
  });
});

describe("Core 1.1 — a form-encoded body", () => {
  const twilio = (requestSchema: Record<string, unknown>) =>
    manifest({
      id: "formbody",
      configurationFields: [
        { id: "account_sid", label: "Account SID", type: "string", required: true },
      ],
      operation: {
        id: "send",
        name: "formbody_send",
        description: "Send a message with a form-encoded body.",
        effect: "send",
        identityMode: "shared_only",
        credentialSlot: "token",
        credentialInjection: {
          in: "header",
          name: "Authorization",
          format: "Basic {token}",
          encoding: "basic",
        },
        source: {
          type: "http",
          method: "POST",
          baseUrl: "https://api.twilio.example",
          path: "/2010-04-01/Accounts/{account_sid}/Messages.json",
          contentType: "form",
        },
        requestSchema,
        response: { maxBytes: 4096, schema: { type: "object" } },
      },
    });

  const flat = {
    type: "object",
    properties: { To: { type: "string" }, Body: { type: "string" } },
    required: ["To", "Body"],
    additionalProperties: false,
  };

  it("refuses a nested body at validation, not at call time", () => {
    expect(() =>
      twilio({
        type: "object",
        properties: { To: { type: "string" }, media: { type: "object" } },
        additionalProperties: false,
      })
    ).toThrow(/form/);
  });

  it("fills the path from configuration and encodes the body as a form", async () => {
    const http = new RecordingHttp([okResponse]);
    const tool = compileOimHttpOperations(twilio(flat), { account_sid: "AC123" })[0];
    if (tool === undefined) throw new Error("no tool compiled");
    // Resolved at compile time, so the contract promises the same URL the dispatch reaches.
    expect(tool.binding.pathTemplate).toBe("/2010-04-01/Accounts/AC123/Messages.json");

    await new OimHttpToolAdapter({ http, binding: tool.binding }).dispatch(
      request({ body: { To: "+14155552671", Body: "hello there" } }),
      "SK1:secret"
    );
    expect(http.sent[0]?.bodyText).toBe("To=%2B14155552671&Body=hello+there");
    expect(http.sent[0]?.body).toBeUndefined();
    expect(http.sent[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("refuses to compile when the installation never supplied the path field", () => {
    expect(() => compileOimHttpOperations(twilio(flat), {})).toThrow(/path_field_unconfigured/);
  });
});

describe("Core 1.1 — a cursor in the request body", () => {
  const compiled = () =>
    compileOimHttpOperations(
      manifest({
        id: "bodycursor",
        operation: {
          id: "search",
          name: "bodycursor_search",
          description: "Search, paging by a cursor the provider wants in the body.",
          effect: "read",
          identityMode: "shared_only",
          credentialSlot: "token",
          credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
          source: {
            type: "http",
            method: "POST",
            baseUrl: "https://api.notion.example",
            path: "/v1/search",
          },
          requestSchema: { type: "object", properties: { query: { type: "string" } } },
          pagination: {
            type: "body_cursor",
            requestPointer: "/start_cursor",
            responsePath: "/next_cursor",
            itemsPath: "/results",
          },
          response: { maxBytes: 4096, schema: { type: "object" } },
        },
      })
    )[0];

  it("gives the Agent one opaque token, never the provider's cursor name", () => {
    const properties = inputProperties(compiled());
    expect(Object.keys(properties).sort()).toEqual(["body", PAGE_TOKEN_ARGUMENT]);
    expect(properties.start_cursor).toBeUndefined();
  });

  it("writes the resumed cursor into the body, not the query string", async () => {
    const http = new RecordingHttp([
      { status: 200, headers: {}, body: { results: [{ id: "a" }], next_cursor: "cursor-2" } },
    ]);
    const tool = compiled();
    if (tool === undefined) throw new Error("no tool compiled");
    const adapter = new OimHttpToolAdapter({
      http,
      binding: tool.binding,
      pagination: tool.pagination,
      toolId: "tool-1",
    });

    const first = (await adapter.dispatch(
      request({ body: { query: "roadmap" } }),
      "secret-token"
    )) as Record<string, string>;
    expect(http.sent[0]?.url).toBe("https://api.notion.example/v1/search");
    expect(http.sent[0]?.body).toEqual({ query: "roadmap" });

    await adapter.dispatch(
      request({
        body: { query: "roadmap" },
        [PAGE_TOKEN_ARGUMENT]: first[NEXT_PAGE_TOKEN_PROPERTY],
      }),
      "secret-token"
    );
    expect(http.sent[1]?.url).toBe("https://api.notion.example/v1/search");
    expect(http.sent[1]?.body).toEqual({ query: "roadmap", start_cursor: "cursor-2" });
  });

  it("stops instead of looping when a provider echoes the cursor it was given", async () => {
    const http = new RecordingHttp([
      { status: 200, headers: {}, body: { results: [{ id: "a" }], next_cursor: "cursor-2" } },
      { status: 200, headers: {}, body: { results: [{ id: "b" }], next_cursor: "cursor-2" } },
    ]);
    const tool = compiled();
    if (tool === undefined) throw new Error("no tool compiled");
    const adapter = new OimHttpToolAdapter({
      http,
      binding: tool.binding,
      pagination: tool.pagination,
      toolId: "tool-1",
    });

    const first = (await adapter.dispatch(
      request({ body: { query: "roadmap" } }),
      "secret-token"
    )) as Record<string, string>;
    const second = (await adapter.dispatch(
      request({
        body: { query: "roadmap" },
        [PAGE_TOKEN_ARGUMENT]: first[NEXT_PAGE_TOKEN_PROPERTY],
      }),
      "secret-token"
    )) as Record<string, string>;

    expect(second[NEXT_PAGE_TOKEN_PROPERTY]).toBeUndefined();
  });
});

describe("Core 1.1 — the version gate", () => {
  it("refuses a 1.0 package that uses a 1.1 construct, naming the construct", () => {
    const built = manifest({
      id: "oldprofile",
      operation: {
        id: "search",
        name: "oldprofile_search",
        description: "A pinned parameter is not part of Core 1.0.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.example.com",
          path: "/v1/search",
          parameters: [{ name: "archived", in: "query", value: "false", schema: {} }],
        },
        response: { maxBytes: 4096, schema: { type: "object" } },
      },
    });
    expect(() => checked({ ...built, profiles: { ...built.profiles, core: "1.0" } })).toThrow(
      /parameter\.value/
    );
  });
});
