import { describe, expect, it } from "vitest";
import { compileOpenApiEgress, EgressCompileError } from "./openapi-compile";

/** Fixture keeps real provider shapes: `$ref`, path-level params, and implicit path required. */
const SPEC = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/search": {
      post: {
        operationId: "search",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/SearchBody" } },
          },
        },
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Results" } } },
          },
        },
      },
    },
    "/pages/{page_id}": {
      parameters: [{ name: "page_id", in: "path", schema: { type: "string" } }],
      get: {
        operationId: "getPage",
        parameters: [
          { name: "filter", in: "query", schema: { type: "string" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
          { name: "session", in: "cookie", schema: { type: "string" } },
        ],
        responses: { "204": {} },
      },
      patch: {
        operationId: "updatePage",
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
  components: {
    schemas: {
      SearchBody: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, parent: { $ref: "#/components/schemas/Block" } },
      },
      Block: {
        type: "object",
        properties: { children: { type: "array", items: { $ref: "#/components/schemas/Block" } } },
      },
      Results: { type: "object", properties: { results: { type: "array" } } },
    },
  },
};

const SEARCH_OP = { operation: "search", name: "search_acme", description: "Search Acme." };

describe("compileOpenApiEgress", () => {
  it("publishes nothing when the egress is not openapi", () => {
    expect(
      compileOpenApiEgress({ slug: "acme", egress: { type: "none" }, document: SPEC })
    ).toEqual([]);
  });

  it("publishes nothing when no operations are declared", () => {
    const compiled = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json" },
      document: SPEC,
    });
    expect(compiled).toEqual([]);
  });

  it("publishes only the declared operations, not every operation in the spec", () => {
    const compiled = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: SPEC,
    });
    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.name).toBe("search_acme");
    expect(compiled[0]?.toolId).toBe("openapi.acme.search_acme");
    expect(compiled[0]?.contract.spec.action).toBe("acme.search_acme");
  });

  it("resolves local $refs so the schema can be compiled by AJV", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: SPEC,
    });
    expect(JSON.stringify(tool?.contract.spec.inputSchema)).not.toContain("$ref");
    const body = (
      tool?.contract.spec.inputSchema.properties as Record<string, { required?: string[] }>
    )?.body;
    expect(body?.required).toEqual(["query"]);
  });

  it("substitutes a permissive schema for a self-referential type rather than recursing forever", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: SPEC,
    });
    const properties = tool?.contract.spec.inputSchema.properties as Record<string, unknown>;
    const nested = JSON.stringify(properties.body);
    expect(nested).toContain("additionalProperties");
    expect(nested).not.toContain("$ref");
  });

  it("never dereferences a remote $ref", () => {
    const remote = {
      ...SPEC,
      paths: {
        "/search": {
          post: {
            operationId: "search",
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "https://evil.example/schema.json" } },
              },
            },
            responses: { "200": {} },
          },
        },
      },
    };
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: remote,
    });
    expect(JSON.stringify(tool?.contract.spec.inputSchema)).not.toContain("evil.example");
  });

  it("merges path-level parameters and marks a path parameter required even when the spec omits it", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [{ operation: "getPage", name: "get_page", description: "Read a page." }],
      },
      document: SPEC,
    });
    expect(tool?.contract.spec.inputSchema.required).toEqual(["page_id"]);
    expect(tool?.binding.params).toContainEqual({ name: "page_id", in: "path" });
    expect(tool?.binding.params).toContainEqual({ name: "filter", in: "query" });
    expect(tool?.binding.params).toContainEqual({ name: "X-Trace", in: "header" });
  });

  it("drops cookie parameters rather than guessing where to send them", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [{ operation: "getPage", name: "get_page", description: "Read a page." }],
      },
      document: SPEC,
    });
    expect(tool?.binding.params.map((p) => p.name)).not.toContain("session");
  });

  it("falls back to a permissive output schema when the operation documents no JSON response", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [{ operation: "getPage", name: "get_page", description: "Read a page." }],
      },
      document: SPEC,
    });
    expect(tool?.contract.spec.outputSchema).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("derives mutating from the method and lets the manifest override it", () => {
    const [read] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [{ operation: "getPage", name: "get_page", description: "Read." }],
      },
      document: SPEC,
    });
    expect(read?.mutating).toBe(false);

    const [written] = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: SPEC,
    });
    expect(written?.mutating).toBe(true);

    const [overridden] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [{ ...SEARCH_OP, mutating: false }],
      },
      document: SPEC,
    });
    expect(overridden?.mutating).toBe(false);
    expect(overridden?.binding.mutating).toBe(false);
    expect(overridden?.contract.spec.idempotency.strategy).toBe("none");
  });

  it("carries the manifest's static headers and auth binding onto every call", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [SEARCH_OP],
        headers: { "Acme-Version": "2026-01-01" },
        auth: { token_env: "ACME_TOKEN" },
      },
      document: SPEC,
    });
    expect(tool?.binding.headers).toEqual({ "Acme-Version": "2026-01-01" });
    expect(tool?.binding.auth).toEqual({
      in: "header",
      header: "Authorization",
      format: "Bearer {token}",
    });
  });

  it("compiles a base_url credential placement and keeps the destination literal", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [SEARCH_OP],
        base_url: "https://api.acme.com/bot{token}",
        auth: { token_env: "ACME_TOKEN", in: "base_url" },
      },
      document: SPEC,
    });
    expect(tool?.binding.auth).toEqual({ in: "base_url" });
    expect(tool?.binding.baseUrl).toBe("https://api.acme.com/bot{token}");
    // The allow-list must still pin one origin — a templated path may not widen it.
    expect(tool?.contract.spec.allowedDestinations).toEqual(["api.acme.com"]);
  });

  it("rejects a base_url placement whose URL has no {token}, which would send no credential", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [SEARCH_OP],
          base_url: "https://api.acme.com",
          auth: { token_env: "ACME_TOKEN", in: "base_url" },
        },
        document: SPEC,
      })
    ).toThrow(/auth_placement_invalid/);
  });

  it("rejects a leftover {token} under header placement, which would ship the placeholder", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [SEARCH_OP],
          base_url: "https://api.acme.com/bot{token}",
          auth: { token_env: "ACME_TOKEN" },
        },
        document: SPEC,
      })
    ).toThrow(/auth_placement_invalid/);
  });

  it("rejects a {token} in the host, which would let a credential choose the destination", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [SEARCH_OP],
          base_url: "https://{token}.acme.com",
          auth: { token_env: "ACME_TOKEN", in: "base_url" },
        },
        document: SPEC,
      })
    ).toThrow(/base_url_invalid/);
  });

  it("honours a non-bearer auth placement", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [SEARCH_OP],
        auth: { token_env: "ACME_TOKEN", header: "X-Api-Key", format: "{token}" },
      },
      document: SPEC,
    });
    expect(tool?.binding.auth).toEqual({ in: "header", header: "X-Api-Key", format: "{token}" });
  });

  it("publishes no auth binding when the manifest declares no credential", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: SPEC,
    });
    expect(tool?.binding.auth).toBeUndefined();
  });

  it("takes the base URL from the spec and lets the manifest override it", () => {
    const [fromSpec] = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: SPEC,
    });
    expect(fromSpec?.binding.baseUrl).toBe("https://api.example.com/v1");

    const [overridden] = compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [SEARCH_OP],
        base_url: "https://eu.example.com/v1/",
      },
      document: SPEC,
    });
    expect(overridden?.binding.baseUrl).toBe("https://eu.example.com/v1");
  });

  it("records the destination host on the contract", () => {
    const [tool] = compileOpenApiEgress({
      slug: "acme",
      egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
      document: SPEC,
    });
    expect(tool?.contract.spec.allowedDestinations).toEqual(["api.example.com"]);
  });

  it("refuses a non-https base URL", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [SEARCH_OP],
          base_url: "http://api.example.com",
        },
        document: SPEC,
      })
    ).toThrow(EgressCompileError);
  });

  it("refuses a base URL whose host is a placeholder", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [SEARCH_OP],
          base_url: "https://{tenant}.example.com",
        },
        document: SPEC,
      })
    ).toThrow(/base_url_invalid/);
  });

  it("refuses a spec whose servers entry is not https, even though the manifest never showed it", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
        document: { ...SPEC, servers: [{ url: "http://api.example.com" }] },
      })
    ).toThrow(/base_url_invalid/);
  });

  it("refuses a base_url aimed at the private network, from the manifest or from the spec", () => {
    // A manifest is authored from chat. Without this, an installed Tool spends the deployment's
    // own credential against cloud metadata or an internal admin port.
    for (const baseUrl of ["https://169.254.169.254", "https://10.0.0.5", "https://127.0.0.1"]) {
      expect(() =>
        compileOpenApiEgress({
          slug: "acme",
          egress: {
            type: "openapi",
            spec: "spec.json",
            operations: [SEARCH_OP],
            base_url: baseUrl,
          },
          document: SPEC,
        })
      ).toThrow(/base_url_invalid.*private_destination/);
    }
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
        document: { ...SPEC, servers: [{ url: "https://192.168.0.1" }] },
      })
    ).toThrow(/base_url_invalid.*private_destination/);
  });

  it("refuses a base_url carrying embedded credentials", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [SEARCH_OP],
          base_url: "https://user:pass@api.example.com",
        },
        document: SPEC,
      })
    ).toThrow(/base_url_invalid.*embedded_credentials/);
  });

  it("refuses an operation the spec does not define", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [{ operation: "nope", name: "nope_tool", description: "x" }],
        },
        document: SPEC,
      })
    ).toThrow(/operation_not_found/);
  });

  it("refuses a tool name the model could not call verbatim", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [{ ...SEARCH_OP, name: "Search Acme" }],
        },
        document: SPEC,
      })
    ).toThrow(/tool_name_invalid/);
  });

  it("refuses two operations claiming the same tool name", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: {
          type: "openapi",
          spec: "spec.json",
          operations: [SEARCH_OP, { ...SEARCH_OP, operation: "getPage" }],
        },
        document: SPEC,
      })
    ).toThrow(/duplicate_tool/);
  });

  it("refuses a document that is not an OpenAPI 3 spec", () => {
    expect(() =>
      compileOpenApiEgress({
        slug: "acme",
        egress: { type: "openapi", spec: "spec.json", operations: [SEARCH_OP] },
        document: { swagger: "2.0", paths: {} },
      })
    ).toThrow(/spec_invalid/);
  });
});

describe("base_url env placeholders", () => {
  const spec = {
    openapi: "3.0.3",
    paths: { "/spaces": { get: { operationId: "listSpaces", responses: { 200: {} } } } },
  };

  const compile = (
    base_url: string,
    env?: Record<string, string>,
    placement?: "header" | "base_url"
  ) =>
    compileOpenApiEgress({
      slug: "acme",
      egress: {
        type: "openapi",
        spec: "openapi.json",
        base_url,
        auth: { token_env: "ACME_TOKEN", ...(placement === undefined ? {} : { in: placement }) },
        operations: [
          { operation: "listSpaces", name: "list_spaces", description: "List Acme spaces." },
        ],
      },
      document: spec,
      ...(env === undefined ? {} : { env }),
    });

  it("fills a per-install path segment from connection env", () => {
    const [tool] = compile("https://api.atlassian.com/ex/confluence/{CLOUD_ID}/wiki", {
      CLOUD_ID: "0e2f-11ee",
    });

    expect(tool.binding.baseUrl).toBe("https://api.atlassian.com/ex/confluence/0e2f-11ee/wiki");
  });

  it("refuses a placeholder the operator never supplied", () => {
    // Left in place it would ask the provider for a site literally named {CLOUD_ID} — a 404 that
    // reads as the provider's fault rather than the manifest's.
    expect(() => compile("https://api.atlassian.com/ex/confluence/{CLOUD_ID}/wiki", {})).toThrow(
      /no connection value for CLOUD_ID/
    );
  });

  it("refuses a connection value that could escape its path segment", () => {
    for (const CLOUD_ID of ["a/../evil", "a?x=1", "a#f", "a%2Fb", "a b", ""]) {
      expect(() =>
        compile("https://api.atlassian.com/ex/confluence/{CLOUD_ID}/wiki", { CLOUD_ID })
      ).toThrow(/base_url_invalid|CLOUD_ID/);
    }
  });

  it("leaves {token} for dispatch, so a compiled binding never holds the credential", () => {
    const [tool] = compile("https://api.telegram.org/bot{token}", {}, "base_url");

    expect(tool.binding.baseUrl).toBe("https://api.telegram.org/bot{token}");
  });

  it("insists the credential placeholder is spelled {token}", () => {
    // Spelling it {ACME_TOKEN} would resolve it from connection env at compile time and bake the
    // credential into a binding that gets logged.
    expect(() => compile("https://api.acme.com/{ACME_TOKEN}", { ACME_TOKEN: "s3cret" })).toThrow(
      /name the credential placeholder \{token\}/
    );
  });

  it("still refuses a templated host, so the allow-list pins one origin", () => {
    expect(() => compile("https://{CLOUD_ID}.atlassian.net/wiki", { CLOUD_ID: "acme" })).toThrow(
      /host must be literal/
    );
  });
});
