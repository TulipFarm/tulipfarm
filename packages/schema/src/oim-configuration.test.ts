import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseOimManifest } from "./oim";

function configuredManifest() {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "example",
      name: "Example",
      version: "1.0.0",
      description: "Read an account using saved configuration.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.1", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "api_token", label: "Token", kind: "api_key", required: true }],
      configurationFields: [
        { id: "user_agent", label: "User-Agent", type: "string", required: true },
      ],
      steps: [
        {
          id: "connect",
          type: "fields",
          title: "Connect",
          fields: [
            {
              id: "api_token",
              label: "Token",
              input: "password",
              required: true,
              target: { type: "credential", slot: "api_token" },
            },
          ],
        },
      ],
    },
    operations: [
      {
        id: "get-identity",
        name: "example_get_identity",
        description: "Read account identity.",
        effect: "read",
        identityMode: "shared_or_personal",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.example.com",
          path: "/me",
          parameters: [
            {
              name: "User-Agent",
              in: "header",
              configurationField: "user_agent",
              schema: { type: "string" },
            },
          ],
        },
        response: { schema: { type: "object" }, projection: ["/id"], maxBytes: 1024 },
      },
    ],
  };
}

function configuredHttpOrigin(baseUrl: string) {
  const manifest = configuredManifest();
  manifest.auth.configurationFields.push(
    { id: "site", label: "Site", type: "url", required: true },
    { id: "account", label: "Account", type: "string", required: true }
  );
  Object.assign(manifest.auth, { allowedOriginHosts: ["*.example.com"] });
  manifest.operations[0].source.baseUrl = baseUrl;
  return manifest;
}

describe("Connection-bound HTTP parameters", () => {
  it("accepts a Core 1.1 header bound to declared non-secret configuration", () => {
    const parsed = parseOimManifest(stringify(configuredManifest()));
    expect(parsed.operations[0]?.source).toMatchObject({
      parameters: [{ name: "User-Agent", configurationField: "user_agent" }],
    });
  });

  it("refuses bindings that are undeclared, secret, ambiguous, incompatible, or under-versioned", () => {
    for (const configurationField of ["missing", "api_token"]) {
      const manifest = configuredManifest();
      manifest.operations[0].source.parameters[0].configurationField = configurationField;
      expect(() => parseOimManifest(stringify(manifest))).toThrow(/configuration field/);
    }
    const ambiguous = configuredManifest();
    Object.assign(ambiguous.operations[0].source.parameters[0], { value: "constant" });
    expect(() => parseOimManifest(stringify(ambiguous))).toThrow(/value.*configurationField/);

    const incompatible = configuredManifest();
    incompatible.operations[0].source.parameters[0].schema.type = "integer";
    expect(() => parseOimManifest(stringify(incompatible))).toThrow(/incompatible/);

    const older = configuredManifest();
    older.profiles.core = "1.0";
    expect(() => parseOimManifest(stringify(older))).toThrow(/core "1.1"/);
  });

  it.each([
    ["url", "string"],
    ["integer", "integer"],
    ["integer", "number"],
    ["boolean", "boolean"],
  ])("accepts %s configuration with a %s parameter schema", (fieldType, parameterType) => {
    const manifest = configuredManifest();
    manifest.auth.configurationFields[0].type = fieldType;
    manifest.operations[0].source.parameters[0].schema.type = parameterType;
    expect(parseOimManifest(stringify(manifest))).toBeDefined();
  });

  it("validates paths and parameters for configured origins exactly like fixed origins", () => {
    const expectInvalidForBothOrigins = (
      mutate: (manifest: ReturnType<typeof configuredHttpOrigin>) => void,
      message: RegExp
    ) => {
      for (const baseUrl of ["https://api.example.com/v1", "https://{site}/v1"]) {
        const manifest = configuredHttpOrigin(baseUrl);
        mutate(manifest);
        expect(() => parseOimManifest(stringify(manifest))).toThrow(message);
      }
    };

    expectInvalidForBothOrigins((manifest) => {
      manifest.operations[0].source.path = "/items/{missing}";
    }, /HTTP path placeholder missing has no parameter/);
    expectInvalidForBothOrigins((manifest) => {
      manifest.operations[0].source.path = "/items/{item}";
      Object.assign(manifest.operations[0].source, {
        parameters: [
          {
            name: "item",
            in: "path",
            required: false,
            schema: { type: "string" },
          },
        ],
      });
    }, /HTTP path parameter item cannot be optional/);
    expectInvalidForBothOrigins((manifest) => {
      Object.assign(manifest.operations[0].source, {
        parameters: [
          { name: "item", in: "query", schema: { type: "string" } },
          { name: "item", in: "header", schema: { type: "string" } },
        ],
      });
    }, /HTTP parameter item is declared more than once/);
    expectInvalidForBothOrigins((manifest) => {
      Object.assign(manifest.operations[0].source, {
        parameters: [{ name: "item", in: "query", schema: { type: "bogus" } }],
      });
    }, /HTTP parameter item schema is invalid/);
  });

  it("accepts configuration-bound paths for fixed and configured origins", () => {
    for (const baseUrl of ["https://api.example.com/v1", "https://{site}/v1"]) {
      const manifest = configuredHttpOrigin(baseUrl);
      manifest.operations[0].source.path = "/items/{account}";
      expect(parseOimManifest(stringify(manifest))).toBeDefined();
    }
  });
});

function configuredGraphql() {
  const base = configuredManifest();
  return {
    ...base,
    auth: {
      ...base.auth,
      configurationFields: [{ id: "site", label: "Site", type: "url", required: true }],
      allowedOriginHosts: ["*.example.com"],
    },
    files: [{ path: "identity.graphql", role: "graphql", sha256: "a".repeat(64) }],
    operations: base.operations.map((operation) => ({
      ...operation,
      source: {
        type: "graphql",
        url: "https://{site}/graphql",
        operation: "Identity",
        documentFile: "identity.graphql",
      },
    })),
  };
}

describe("Connection-bound GraphQL URLs", () => {
  it("accepts a Core 1.1 host from declared configuration bounded by allowed hosts", () => {
    expect(parseOimManifest(stringify(configuredGraphql())).operations[0]?.source).toMatchObject({
      type: "graphql",
      url: "https://{site}/graphql",
    });
  });

  it("refuses placeholders outside the complete host or repeated elsewhere in the URL", () => {
    for (const url of [
      "https://api.example.com/{site}",
      "https://{site}.example.com/graphql",
      "https://{site}/graphql?account={site}",
      "https://api.example.com/graphql?account={site}",
    ]) {
      const manifest = configuredGraphql();
      manifest.operations[0].source.url = url;
      expect(() => parseOimManifest(stringify(manifest))).toThrow(/host placeholder/);
    }
  });

  it("refuses missing fields, non-string fields, unbounded hosts, and Core 1.0 templates", () => {
    const missing = configuredGraphql();
    missing.auth.configurationFields = [];
    expect(() => parseOimManifest(stringify(missing))).toThrow(/no configuration field declares/);

    const scalar = configuredGraphql();
    scalar.auth.configurationFields[0].type = "boolean";
    expect(() => parseOimManifest(stringify(scalar))).toThrow(/url or string/);

    const unbounded = configuredGraphql();
    Object.assign(unbounded.auth, { allowedOriginHosts: undefined });
    expect(() => parseOimManifest(stringify(unbounded))).toThrow(/allowedOriginHosts/);

    const privateHost = configuredGraphql();
    privateHost.auth.allowedOriginHosts = ["*.127.0.0.1"];
    expect(() => parseOimManifest(stringify(privateHost))).toThrow(/public hostname/);

    const older = configuredGraphql();
    older.profiles.core = "1.0";
    expect(() => parseOimManifest(stringify(older))).toThrow(/core "1.1"/);
  });

  it("preserves Core 1.0 literal public GraphQL URLs", () => {
    const manifest = configuredGraphql();
    manifest.profiles.core = "1.0";
    manifest.operations[0].source.url = "https://api.example.com/graphql";
    expect(parseOimManifest(stringify(manifest))).toBeDefined();
  });
});
