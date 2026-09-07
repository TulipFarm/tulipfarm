import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { compileOimOpenApiOperations, OimOpenApiCompileError } from "./oim-openapi-compile";

const DOCUMENT = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.tasks.example/v1" }],
  paths: {
    "/issues/{issue_id}": {
      get: {
        operationId: "getIssue",
        parameters: [
          {
            name: "issue_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "Authorization",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

function manifest(baseUrl?: string): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "tasks",
      name: "Tasks",
      version: "1.2.0",
      description: "Read tasks.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [{ id: "site", label: "Site", type: "string" }],
      allowedOriginHosts: ["*.tasks.example"],
      steps: [],
    },
    operations: [
      {
        id: "get-issue",
        name: "get_issue",
        description: "Read one issue.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "api_key",
        credentialInjection: {
          in: "header",
          name: "Authorization",
          format: "Token {token}",
        },
        source: {
          type: "openapi",
          file: "openapi.yaml",
          operationId: "getIssue",
          ...(baseUrl === undefined ? {} : { baseUrl }),
        },
        response: {
          schema: {
            type: "object",
            properties: { id: { type: "string" } },
            additionalProperties: false,
          },
          projection: ["/id"],
          maxBytes: 16_384,
        },
      },
    ],
    files: [
      {
        path: "openapi.yaml",
        role: "openapi",
        sha256: "0".repeat(64),
      },
    ],
  } as OimManifest;
}

describe("compileOimOpenApiOperations", () => {
  it("derives the request from OpenAPI and keeps OIM authority and response semantics", () => {
    const [compiled] = compileOimOpenApiOperations(
      manifest(),
      new Map([["openapi.yaml", DOCUMENT]])
    );

    expect(compiled?.toolId).toBe("oim.tasks.v1.get-issue");
    expect(compiled?.contract.spec).toMatchObject({
      toolVersion: "1.2.0",
      action: "integration.tasks.get_issue",
      mutating: false,
      riskClass: "low",
      allowedDestinations: ["api.tasks.example"],
      retry: { maxAttempts: 3, safeToRetry: true },
      outputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
    });
    expect(compiled?.contract.spec.inputSchema).toMatchObject({
      required: ["issue_id"],
      properties: { issue_id: { type: "string" } },
    });
    if (compiled === undefined) throw new Error("expected compiled operation");
    expect(
      (compiled.contract.spec.inputSchema.properties as Record<string, unknown>).Authorization
    ).toBeUndefined();
    expect(compiled?.binding).toMatchObject({
      method: "GET",
      baseUrl: "https://api.tasks.example/v1",
      pathTemplate: "/issues/{issue_id}",
      maxResponseBytes: 16_384,
      auth: {
        in: "header",
        credentialSlot: "api_key",
        header: "Authorization",
        format: "Token {token}",
      },
    });
    expect(compiled?.projection).toEqual(["/id"]);
  });

  it("defers tenant configuration for registration and resolves it for dispatch", () => {
    const input = manifest("https://{site}/api");
    const [registered] = compileOimOpenApiOperations(
      input,
      new Map([["openapi.yaml", DOCUMENT]]),
      {},
      { deferConfiguration: true }
    );
    const [dispatched] = compileOimOpenApiOperations(input, new Map([["openapi.yaml", DOCUMENT]]), {
      site: "acme.tasks.example",
    });

    expect(registered?.contract.spec.inputSchema).toEqual(dispatched?.contract.spec.inputSchema);
    expect(registered?.adapterRef).toBe(dispatched?.adapterRef);
    expect(dispatched?.binding.baseUrl).toBe("https://acme.tasks.example/api");
    expect(dispatched?.contract.spec.allowedDestinations).toEqual(["acme.tasks.example"]);
  });

  it("binds the OIM-declared provider retry header", () => {
    const input = manifest();
    const operation = input.operations[0];
    if (operation === undefined) throw new Error("fixture");
    operation.rateLimit = {
      requests: 10,
      perSeconds: 60,
      scope: "connection",
      retryAfterHeader: "X-Rate-Reset",
    };

    expect(
      compileOimOpenApiOperations(input, new Map([["openapi.yaml", DOCUMENT]]))[0]?.binding
        .retryAfterHeader
    ).toBe("X-Rate-Reset");
  });

  it("refuses a missing declared companion", () => {
    expect(() => compileOimOpenApiOperations(manifest(), new Map())).toThrow(
      new OimOpenApiCompileError("document_missing", "get-issue")
    );
  });
});
