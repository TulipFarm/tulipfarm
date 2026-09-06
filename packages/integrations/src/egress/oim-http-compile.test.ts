import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { compileOimHttpOperations, OimHttpCompileError } from "./oim-http-compile";

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.2.3",
      description: "Read weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "current-weather",
        name: "current_weather",
        description: "Read current weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/v1/current/{location}",
          parameters: [
            { name: "location", in: "path", schema: { type: "string" } },
            { name: "units", in: "query", schema: { type: "string" } },
          ],
        },
        response: {
          schema: { type: "object" },
          projection: ["/temperature", "/conditions"],
          maxBytes: 16_384,
        },
      },
    ],
  };
}

describe("compileOimHttpOperations", () => {
  it("emits a stable contract and native binding", () => {
    const [compiled] = compileOimHttpOperations(manifest());

    expect(compiled?.toolId).toBe("oim.weather.v1.current-weather");
    expect(compiled?.contract.spec).toMatchObject({
      toolVersion: "1.2.3",
      action: "integration.weather.current_weather",
      riskClass: "low",
      mutating: false,
      allowedDestinations: ["api.weather.example"],
      adapter: { kind: "native", ref: compiled?.adapterRef },
    });
    expect(compiled?.contract.spec.inputSchema).toEqual({
      type: "object",
      properties: {
        location: { type: "string" },
        units: { type: "string" },
      },
      additionalProperties: false,
      required: ["location"],
    });
    expect(compiled?.binding).toMatchObject({
      method: "GET",
      pathTemplate: "/v1/current/{location}",
      maxResponseBytes: 16_384,
      params: [
        { name: "location", in: "path" },
        { name: "units", in: "query" },
      ],
    });
  });

  it("uses the declared effect instead of the HTTP method", () => {
    const input = manifest();
    input.operations[0].source = {
      type: "http",
      method: "POST",
      baseUrl: "https://api.weather.example",
      path: "/v1/search",
    };
    input.operations[0].requestSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };

    const [compiled] = compileOimHttpOperations(input);
    expect(compiled?.contract.spec.mutating).toBe(false);
    expect(compiled?.contract.spec.idempotency.strategy).toBe("none");
    expect(compiled?.contract.spec.inputSchema).toMatchObject({
      required: ["body"],
      properties: { body: input.operations[0].requestSchema },
    });
  });

  it("compiles declared credential injection and fails closed when it is missing", () => {
    const input = manifest();
    input.operations[0].credentialSlot = "api_key";
    input.operations[0].credentialInjection = {
      in: "header",
      name: "authorization",
      format: "Bearer {token}",
    };

    expect(compileOimHttpOperations(input)[0]?.binding.auth).toEqual({
      in: "header",
      credentialSlot: "api_key",
      header: "authorization",
      format: "Bearer {token}",
    });

    delete input.operations[0].credentialInjection;

    expect(() => compileOimHttpOperations(input)).toThrow(
      new OimHttpCompileError("credential_injection_missing", "current-weather")
    );
  });
});

describe("compileOimHttpOperations pagination", () => {
  function paginated(pagination: NonNullable<OimManifest["operations"][number]["pagination"]>) {
    const base = manifest();
    const operation = base.operations[0];
    if (operation === undefined) throw new Error("fixture missing operation");
    return { ...base, operations: [{ ...operation, pagination }] };
  }

  it("offers the Agent one opaque token argument, not the provider's cursor parameter", () => {
    const [compiled] = compileOimHttpOperations(
      paginated({ type: "cursor", requestParameter: "startAt", responsePath: "/nextCursor" })
    );
    const input = compiled?.contract.spec.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(input.properties).toHaveProperty("page_token");
    expect(input.properties).not.toHaveProperty("startAt");
    expect(input.required ?? []).not.toContain("page_token");
    expect(compiled?.pagination).toEqual({
      type: "cursor",
      requestParameter: "startAt",
      responsePath: "/nextCursor",
    });
  });

  it("widens the output schema by the token the host adds", () => {
    const [compiled] = compileOimHttpOperations(paginated({ type: "link" }));
    const output = compiled?.contract.spec.outputSchema as { properties: Record<string, unknown> };

    expect(output.properties).toHaveProperty("next_page_token");
  });

  it("refuses a manifest that also exposes the cursor parameter to the Agent", () => {
    expect(() =>
      compileOimHttpOperations(
        paginated({ type: "cursor", requestParameter: "units", responsePath: "/nextCursor" })
      )
    ).toThrow(OimHttpCompileError);
  });
});

describe("compileOimHttpOperations files", () => {
  it("makes multipart File ids an input but gives binary responses a File result", () => {
    const input = manifest();
    input.profiles.core = "1.2";
    input.operations[0].source = {
      type: "http",
      method: "POST",
      baseUrl: "https://api.weather.example",
      path: "/v1/export",
      contentType: "multipart",
      multipart: {
        parts: [{ name: "file", kind: "file", pointer: "/fileId" }],
      },
    };
    input.operations[0].requestSchema = {
      type: "object",
      properties: { fileId: { type: "string" } },
      required: ["fileId"],
      additionalProperties: false,
    };
    input.operations[0].response = { mode: "binary", maxBytes: 16 };

    const [compiled] = compileOimHttpOperations(input);

    expect(compiled?.contract.spec.inputSchema).toMatchObject({
      properties: { body: input.operations[0].requestSchema },
    });
    expect(compiled?.binding).toMatchObject({
      contentType: "multipart",
      binaryResponse: true,
      multipart: [{ name: "file", kind: "file", pointer: "/fileId" }],
    });
    expect(compiled?.contract.spec.outputSchema).toMatchObject({
      required: ["fileId", "summary"],
    });
  });
});

describe("templated origins", () => {
  function templated(): OimManifest {
    const base = manifest();
    return {
      ...base,
      profiles: { ...base.profiles, auth: "1.0" },
      auth: {
        credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key", required: true }],
        configurationFields: [{ id: "site", label: "Site", type: "url", required: true }],
        allowedOriginHosts: ["*.weather.example"],
        steps: [
          {
            id: "connect",
            title: "Create a token",
            type: "fields",
            fields: [
              {
                id: "api_token",
                label: "API token",
                input: "password",
                target: { type: "credential", slot: "api_token" },
                required: true,
              },
              {
                id: "site",
                label: "Site",
                input: "url",
                target: { type: "configuration", field: "site" },
                required: true,
              },
            ],
          },
        ],
      },
      operations: base.operations.map((operation) => ({
        ...operation,
        source: { ...operation.source, baseUrl: "https://{site}/v1" },
      })) as OimManifest["operations"],
    };
  }

  it("resolves the host from installation configuration", () => {
    const [tool] = compileOimHttpOperations(templated(), { site: "acme.weather.example" });
    expect(tool.binding.baseUrl).toBe("https://acme.weather.example/v1");
    expect(tool.contract.spec.allowedDestinations).toEqual(["acme.weather.example"]);
  });

  it("accepts a full origin the operator pasted from a browser", () => {
    const [tool] = compileOimHttpOperations(templated(), {
      site: "https://acme.weather.example/wiki",
    });
    expect(tool.binding.baseUrl).toBe("https://acme.weather.example/v1");
  });

  it("refuses to compile when the configuration field is absent", () => {
    expect(() => compileOimHttpOperations(templated())).toThrow(
      expect.objectContaining({ code: "origin_unconfigured" })
    );
  });

  it("refuses a host outside the declared origins", () => {
    expect(() => compileOimHttpOperations(templated(), { site: "attacker.example" })).toThrow(
      expect.objectContaining({ code: "origin_not_allowed" })
    );
  });

  it("refuses the bare parent of a wildcard origin", () => {
    expect(() => compileOimHttpOperations(templated(), { site: "weather.example" })).toThrow(
      OimHttpCompileError
    );
  });
});
