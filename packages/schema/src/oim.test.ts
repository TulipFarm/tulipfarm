import { describe, expect, it } from "vitest";
import { TulipFarmValidationError } from "./error";
import {
  OIM_CONFORMANCE_CASES,
  OIM_CORE_PROFILE_VERSIONS,
  OIM_EFFECT_CLASSES,
  OIM_FILE_ROLES,
  OIM_IDENTITY_MODES,
  OimConformanceClaimSchema,
  type OimManifest,
  OimManifestSchema,
  oimCompatibilityIssues,
  oimConformanceIssues,
  oimFileDigest,
  oimManifestIssues,
  oimOriginAllowed,
  oimOriginPlaceholder,
  oimPackageDigest,
  oimPackageIssues,
  oimToolId,
  parseOimManifest,
  validateOimManifest,
} from "./oim";

function valid(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.2.3",
      description: "Read current weather from a public provider.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "current-weather",
        name: "current_weather",
        description: "Read current weather for one location.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/v1/current",
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

function jsonResponse(manifest: OimManifest) {
  const response = manifest.operations[0].response;
  if (response.mode === "binary") throw new Error("fixture");
  return response;
}

describe("validateOimManifest", () => {
  it("accepts a minimal Core profile Integration", () => {
    expect(validateOimManifest(valid())).toEqual(valid());
  });

  it("accepts constant OAuth authorization parameters but reserves protocol parameters", () => {
    const manifest = valid();
    manifest.profiles.auth = "1.0";
    manifest.auth = {
      credentialSlots: [
        { id: "client_id", label: "Client ID", kind: "api_key", required: true },
        { id: "access_token", label: "Access token", kind: "oauth2_access_token", required: true },
      ],
      steps: [
        {
          id: "consent",
          title: "Authorize",
          type: "oauth2",
          authorizationUrl: "https://accounts.example.com/oauth/authorize",
          tokenUrl: "https://accounts.example.com/oauth/token",
          scopes: ["read"],
          authorizationParameters: { access_type: "offline", prompt: "consent" },
          clientId: { type: "credential", slot: "client_id" },
          bindings: [
            { sourcePath: "/access_token", target: { type: "credential", slot: "access_token" } },
          ],
        },
      ],
    };

    expect(validateOimManifest(manifest)).toEqual(manifest);

    const oauth = manifest.auth.steps[0];
    if (oauth.type !== "oauth2") throw new Error("expected OAuth step");
    oauth.authorizationParameters = { state: "package-owned" };
    expect(oimManifestIssues(manifest)).toContain(
      "auth: step consent authorizationParameters cannot set host-owned state"
    );
  });

  it("validates OAuth token endpoint client authentication", () => {
    const manifest = valid();
    manifest.profiles.auth = "1.0";
    manifest.auth = {
      credentialSlots: [
        { id: "client_id", label: "Client ID", kind: "api_key", required: true },
        { id: "access_token", label: "Access token", kind: "oauth2_access_token", required: true },
      ],
      steps: [
        {
          id: "consent",
          title: "Authorize",
          type: "oauth2",
          authorizationUrl: "https://accounts.example.com/oauth/authorize",
          tokenUrl: "https://accounts.example.com/oauth/token",
          tokenEndpointAuthMethod: "none",
          scopes: ["read"],
          pkce: true,
          clientId: { type: "credential", slot: "client_id" },
          bindings: [
            { sourcePath: "/access_token", target: { type: "credential", slot: "access_token" } },
          ],
        },
      ],
    };
    expect(validateOimManifest(manifest)).toEqual(manifest);

    const oauth = manifest.auth.steps[0];
    if (oauth.type !== "oauth2") throw new Error("expected OAuth step");
    oauth.tokenEndpointAuthMethod = "client_secret_basic";
    expect(oimManifestIssues(manifest)).toContain(
      "auth: step consent tokenEndpointAuthMethod client_secret_basic requires clientSecret"
    );

    manifest.auth.credentialSlots.push({
      id: "client_secret",
      label: "Client secret",
      kind: "client_secret",
      required: true,
    });
    oauth.clientSecret = { type: "credential", slot: "client_secret" };
    expect(validateOimManifest(manifest)).toEqual(manifest);

    oauth.tokenEndpointAuthMethod = "none";
    expect(oimManifestIssues(manifest)).toContain(
      "auth: step consent tokenEndpointAuthMethod none cannot declare clientSecret"
    );
    oauth.clientSecret = undefined;
    oauth.pkce = false;
    expect(oimManifestIssues(manifest)).toContain(
      "auth: step consent public OAuth client requires PKCE"
    );
  });

  it("accepts a webhook registration step bound to native HTTP operations", () => {
    const manifest = valid();
    manifest.profiles = { core: "1.0", auth: "1.0", events: "1.0" };
    manifest.auth = {
      credentialSlots: [
        { id: "token", label: "Token", kind: "api_key" },
        { id: "webhook_secret", label: "Webhook Secret", kind: "webhook_secret" },
      ],
      steps: [
        {
          id: "token",
          title: "Token",
          type: "fields",
          fields: [
            {
              id: "token",
              label: "Token",
              input: "password",
              target: { type: "credential", slot: "token" },
            },
          ],
        },
        {
          id: "webhook",
          title: "Register webhook",
          type: "webhook",
          operationId: "register-webhook",
          unregisterOperationId: "unregister-webhook",
          subscriptionIdPath: "/id",
          secretSlot: "webhook_secret",
          registration: {
            callbackUrl: { in: "body", pointer: "/callback_url" },
            secret: { in: "body", pointer: "/secret" },
          },
          unregistration: { subscriptionId: { in: "body", pointer: "/subscription_id" } },
        },
      ],
    };
    manifest.operations.push(
      {
        id: "register-webhook",
        name: "register_webhook",
        description: "Register a webhook.",
        effect: "create",
        identityMode: "shared_only",
        credentialSlot: "token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "POST",
          baseUrl: "https://api.weather.example",
          path: "/webhooks",
        },
        requestSchema: { type: "object" },
        response: { schema: { type: "object" }, maxBytes: 4_096 },
      },
      {
        id: "unregister-webhook",
        name: "unregister_webhook",
        description: "Remove a webhook.",
        effect: "delete",
        identityMode: "shared_only",
        credentialSlot: "token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "DELETE",
          baseUrl: "https://api.weather.example",
          path: "/webhooks",
        },
        requestSchema: { type: "object" },
        response: { schema: { type: "object" }, maxBytes: 4_096 },
      }
    );
    manifest.events = {
      path: "/weather",
      verification: {
        scheme: "hmac_sha256",
        secretSlot: "webhook_secret",
        signatureHeader: "x-signature",
        signatureEncoding: "hex",
      },
      deduplication: { kind: "none" },
      eventTypes: [
        {
          type: "updated",
          selector: { pointer: "/type", equals: "updated" },
          schema: { type: "object" },
        },
      ],
    };

    expect(oimManifestIssues(manifest)).toEqual([]);
  });

  it("accepts polling ingress only when it names a cursor-capable read operation", () => {
    const manifest = valid();
    manifest.profiles = { core: "1.0", events: "1.0" };
    manifest.operations[0].source = {
      type: "http",
      method: "GET",
      baseUrl: "https://api.weather.example",
      path: "/events",
      parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }],
    };
    manifest.events = {
      path: "/weather",
      verification: { scheme: "shared_secret", secretSlot: "token", signatureHeader: "x-token" },
      deduplication: { kind: "none" },
      eventTypes: [
        {
          type: "updated",
          selector: { pointer: "/type", equals: "updated" },
          schema: { type: "object" },
        },
      ],
    };
    manifest.ingress = {
      kind: "polling",
      operationId: "current-weather",
      intervalSeconds: 60,
      cursor: { responsePointer: "/cursor", requestParameter: "cursor" },
    };

    expect(oimManifestIssues(manifest)).toEqual([]);
  });

  it("accepts max-integer-plus-one polling cursors for batched provider updates", () => {
    const manifest = valid();
    manifest.profiles = { core: "1.0", events: "1.0" };
    manifest.operations[0].effect = "sensitive_read";
    manifest.operations[0].source = {
      type: "http",
      method: "GET",
      baseUrl: "https://api.weather.example",
      path: "/events",
      parameters: [{ name: "offset", in: "query", schema: { type: "integer" } }],
    };
    (manifest as OimManifest & { ingress: unknown }).ingress = {
      kind: "polling",
      operationId: "current-weather",
      intervalSeconds: 60,
      eventTypes: [
        {
          type: "updated",
          selector: { pointer: "/type", equals: "updated" },
          schema: { type: "object" },
        },
      ],
      cursor: {
        mode: "max_integer_plus_one",
        responsePointer: "/result",
        itemPointer: "/update_id",
        requestParameter: "offset",
      },
    };

    expect(validateOimManifest(manifest)).toEqual(manifest);
    expect(oimManifestIssues(manifest)).toEqual([]);
  });

  it("rejects a max-integer cursor without an item pointer", () => {
    const manifest = valid() as OimManifest & { ingress: unknown };
    manifest.ingress = {
      kind: "polling",
      operationId: "current-weather",
      intervalSeconds: 60,
      cursor: {
        mode: "max_integer_plus_one",
        responsePointer: "/result",
        requestParameter: "offset",
      },
    };

    expect(() => validateOimManifest(manifest)).toThrow(TulipFarmValidationError);
  });

  it("rejects polling ingress below the provider-safe interval floor", () => {
    const manifest = valid() as OimManifest & { ingress: unknown };
    manifest.ingress = {
      kind: "polling",
      operationId: "current-weather",
      intervalSeconds: 5,
      cursor: { responsePointer: "/cursor", requestParameter: "cursor" },
    };

    expect(() => validateOimManifest(manifest)).toThrow(TulipFarmValidationError);
  });

  it("rejects unknown fields instead of silently ignoring them", () => {
    expect(() =>
      validateOimManifest({
        ...valid(),
        dependencies: ["vendor-sdk"],
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects a non-semver package version", () => {
    expect(() =>
      validateOimManifest({
        ...valid(),
        metadata: { ...valid().metadata, version: "latest" },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects SemVer prerelease numbers with leading zeroes", () => {
    expect(() =>
      validateOimManifest({
        ...valid(),
        metadata: { ...valid().metadata, version: "1.0.0-01" },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("accepts bounded SemVer build metadata", () => {
    const manifest = valid();
    manifest.metadata.version = `1.0.0+${"a".repeat(40)}`;
    expect(validateOimManifest(manifest)).toEqual(manifest);
  });

  it("rejects extension keys outside the lowercase x-* namespace", () => {
    expect(() =>
      validateOimManifest({
        ...valid(),
        extensions: { foo: true },
      })
    ).toThrow(TulipFarmValidationError);
    expect(() =>
      validateOimManifest({
        ...valid(),
        extensions: { "x-Upper": true },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects unsafe URLs and scheme-relative HTTP paths", () => {
    const schemeRelative = valid();
    schemeRelative.operations[0].source = {
      type: "http",
      method: "GET",
      baseUrl: "https://api.weather.example",
      path: "//evil.example/steal",
    };
    expect(oimManifestIssues(schemeRelative)).toContain(
      "operations: current-weather HTTP path must start with exactly one slash"
    );

    const invalidPort = valid();
    invalidPort.operations[0].source = {
      type: "http",
      method: "GET",
      baseUrl: "https://api.weather.example:99999",
      path: "/v1/current",
    };
    expect(oimManifestIssues(invalidPort)).toContain(
      "operations: current-weather baseUrl is not a valid HTTPS URL"
    );

    const localTarget = valid();
    localTarget.operations[0].source = {
      type: "http",
      method: "GET",
      baseUrl: "https://127.0.0.1",
      path: "/v1/current",
    };
    expect(oimManifestIssues(localTarget)).toContain(
      "operations: current-weather baseUrl must use a public HTTPS URL"
    );
  });

  it("validates native HTTP parameter bindings against the path", () => {
    const manifest = valid();
    const operation = manifest.operations[0];
    operation.source = {
      type: "http",
      method: "GET",
      baseUrl: "https://api.weather.example",
      path: "/v1/current/{location}",
      parameters: [
        {
          name: "location",
          in: "path",
          schema: { type: "string" },
        },
        {
          name: "units",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
      ],
    };

    expect(oimManifestIssues(manifest)).toEqual([]);

    operation.source.parameters = [
      {
        name: "units",
        in: "query",
        schema: { type: "string" },
      },
    ];
    expect(oimManifestIssues(manifest)).toContain(
      "operations: current-weather HTTP path placeholder location has no parameter"
    );
  });

  it("rejects malformed embedded JSON Schemas", () => {
    const manifest = valid();
    jsonResponse(manifest).schema = { type: "bogus" };
    expect(oimManifestIssues(manifest)).toContain(
      "operations: current-weather response schema is invalid"
    );
  });

  it("bounds identifiers so a derived Tool id always fits the Tool contract", () => {
    const manifest = valid();
    manifest.metadata.id = `a${"b".repeat(96)}`;
    expect(() => validateOimManifest(manifest)).toThrow(TulipFarmValidationError);
  });

  it("emits profile and operation vocabularies as string enums", () => {
    expect(OimManifestSchema.properties.profiles.properties.core).toMatchObject({
      type: "string",
      enum: [...OIM_CORE_PROFILE_VERSIONS],
    });
    const operation = OimManifestSchema.properties.operations.items;
    expect(operation.properties.effect).toMatchObject({
      type: "string",
      enum: [...OIM_EFFECT_CLASSES],
    });
    expect(operation.properties.identityMode).toMatchObject({
      type: "string",
      enum: [...OIM_IDENTITY_MODES],
    });
    expect(OimManifestSchema.properties.files.items.properties.role).toMatchObject({
      type: "string",
      enum: [...OIM_FILE_ROLES],
    });
  });
});

describe("parseOimManifest", () => {
  it("parses YAML through the structural and cross-field gates", () => {
    const parsed = parseOimManifest(`
oimVersion: "1.0"
kind: Integration
metadata:
  id: weather
  name: Weather
  version: 1.2.3
  description: Read current weather from a public provider.
  license: Apache-2.0
profiles:
  core: "1.0"
operations:
  - id: current-weather
    name: current_weather
    description: Read current weather for one location.
    effect: read
    identityMode: shared_only
    source:
      type: http
      method: GET
      baseUrl: https://api.weather.example
      path: /v1/current
    response:
      schema: { type: object }
      projection: [/temperature]
      maxBytes: 16384
`);
    expect(parsed.metadata.id).toBe("weather");
  });

  it("rejects a hook when the Hooks profile is not claimed", () => {
    const manifest = valid();
    manifest.files = [
      {
        path: "hooks/normalize.js",
        role: "hook",
        sha256: "0".repeat(64),
      },
    ];
    manifest.hooks = [
      {
        kind: "response_normalize",
        file: "hooks/normalize.js",
        export: "normalize",
      },
    ];

    expect(oimManifestIssues(manifest)).toContain(
      'profiles: hooks "1.0" is required when hooks are declared'
    );
  });

  it("rejects prohibited dependency and install files", () => {
    const source = `
oimVersion: "1.0"
kind: Integration
metadata:
  id: weather
  name: Weather
  version: 1.2.3
  description: Read current weather from a public provider.
  license: Apache-2.0
profiles: { core: "1.0" }
files:
  - path: package.json
    role: fixture
    sha256: "${"0".repeat(64)}"
operations:
  - id: current-weather
    name: current_weather
    description: Read current weather for one location.
    effect: read
    identityMode: shared_only
    source:
      type: http
      method: GET
      baseUrl: https://api.weather.example
      path: /v1/current
    response:
      schema: { type: object }
      maxBytes: 16384
`;
    expect(() => parseOimManifest(source)).toThrow(/package.json is not allowed/);
  });
});

describe("OIM package integrity", () => {
  it("accepts an exact declared companion set with matching digests", () => {
    const manifest = valid();
    const guide = "# Weather setup\n";
    manifest.files = [
      {
        path: "setup-guide.md",
        role: "guide",
        sha256: oimFileDigest(guide),
      },
    ];

    expect(oimPackageIssues(manifest, new Map([["setup-guide.md", guide]]))).toEqual([]);
  });

  it("reports missing, undeclared, and changed files together", () => {
    const manifest = valid();
    manifest.files = [
      {
        path: "setup-guide.md",
        role: "guide",
        sha256: oimFileDigest("# expected\n"),
      },
    ];

    expect(
      oimPackageIssues(
        manifest,
        new Map([
          ["setup-guide.md", "# changed\n"],
          ["surprise.json", "{}"],
        ])
      )
    ).toEqual([
      "files: setup-guide.md digest does not match the manifest",
      "files: surprise.json is present but not declared",
    ]);
  });

  it.each(["npm-shrinkwrap.json", "composer.json", "preinstall.js"])(
    "rejects prohibited package file %s",
    (path) => {
      const manifest = valid();
      manifest.files = [{ path, role: "fixture", sha256: oimFileDigest("{}") }];
      expect(oimManifestIssues(manifest)).toContain(
        `files: ${path} is not allowed in an OIM package`
      );
    }
  );

  it("rejects manifest.yml as a companion file", () => {
    const manifest = valid();
    manifest.files = [
      {
        path: "manifest.yml",
        role: "fixture",
        sha256: oimFileDigest("entry: duplicate"),
      },
    ];
    expect(oimManifestIssues(manifest)).toContain(
      "files: manifest.yml is the OIM entry point and cannot be a companion file"
    );
  });

  it("rejects binary content disguised with a text extension", () => {
    const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]);
    const manifest = valid();
    manifest.files = [
      {
        path: "payload.txt",
        role: "fixture",
        sha256: oimFileDigest(binary),
      },
    ];
    expect(oimPackageIssues(manifest, new Map([["payload.txt", binary]]))).toContain(
      "files: payload.txt must contain UTF-8 text, not binary data"
    );
  });

  it("validates the selected OpenAPI operation and its effective servers", () => {
    const openapi = [
      "openapi: 3.1.0",
      "info:",
      "  title: Unsafe",
      "  version: 1.0.0",
      "servers:",
      "  - url: https://api.weather.example",
      "paths:",
      "  /weather:",
      "    get:",
      "      operationId: getWeather",
      "      servers:",
      "        - url: https://127.0.0.1",
      "      responses:",
      '        "200":',
      "          description: OK",
    ].join("\n");
    const manifest = valid();
    manifest.files = [
      {
        path: "api/openapi.yaml",
        role: "openapi",
        sha256: oimFileDigest(openapi),
      },
    ];
    manifest.operations[0].source = {
      type: "openapi",
      file: "api/openapi.yaml",
      operationId: "getWeather",
    };

    expect(oimPackageIssues(manifest, new Map([["api/openapi.yaml", openapi]]))).toContain(
      "operations: current-weather OpenAPI operation must resolve only to public HTTPS servers"
    );

    const missingOperation = structuredClone(manifest);
    if (missingOperation.operations[0].source.type !== "openapi") {
      throw new Error("expected OpenAPI operation");
    }
    missingOperation.operations[0].source.operationId = "missing";
    expect(oimPackageIssues(missingOperation, new Map([["api/openapi.yaml", openapi]]))).toContain(
      "operations: current-weather OpenAPI document must define operationId missing exactly once"
    );
  });

  it("parses GraphQL companions and requires the selected named operation", () => {
    const graphql = "this is not GraphQL";
    const manifest = valid();
    manifest.files = [
      {
        path: "api/weather.graphql",
        role: "graphql",
        sha256: oimFileDigest(graphql),
      },
    ];
    manifest.operations[0].source = {
      type: "graphql",
      url: "https://api.weather.example/graphql",
      documentFile: "api/weather.graphql",
      operation: "GetWeather",
    };

    expect(oimPackageIssues(manifest, new Map([["api/weather.graphql", graphql]]))).toContain(
      "operations: current-weather GraphQL document is invalid"
    );
  });

  it("requires operation and hook file references to name declared files with the right role", () => {
    const manifest = valid();
    manifest.files = [
      {
        path: "api/openapi.yaml",
        role: "guide",
        sha256: "0".repeat(64),
      },
    ];
    manifest.operations[0] = {
      ...manifest.operations[0],
      source: {
        type: "openapi",
        file: "api/openapi.yaml",
        operationId: "getWeather",
      },
    };

    expect(oimManifestIssues(manifest)).toContain(
      "operations: current-weather references api/openapi.yaml as OpenAPI, but its role is guide"
    );
  });

  it("derives stable Tool identity from package id, major version, and operation id", () => {
    expect(oimToolId(valid(), "current-weather")).toBe("oim.weather.v1.current-weather");
  });

  it("changes the package digest when a companion digest changes", () => {
    const first = valid();
    first.files = [{ path: "guide.md", role: "guide", sha256: "0".repeat(64) }];
    const second = structuredClone(first);
    if (!second.files) throw new Error("expected companion files");
    second.files[0].sha256 = "1".repeat(64);

    expect(oimPackageDigest(first)).toHaveLength(64);
    expect(oimPackageDigest(first)).not.toBe(oimPackageDigest(second));
  });
});

describe("OIM Core 1.1 credential pairs", () => {
  it("accepts two credential slots only when both the slots and locations differ", () => {
    const manifest = valid();
    manifest.profiles.core = "1.1";
    manifest.profiles.auth = "1.0";
    manifest.auth = {
      credentialSlots: [
        { id: "api_key", label: "API key", kind: "api_key", required: true },
        { id: "token", label: "Token", kind: "bearer_token", required: true },
      ],
      steps: [
        {
          id: "credentials",
          type: "fields",
          title: "Enter credentials",
          fields: [
            {
              id: "api_key",
              label: "API key",
              input: "password",
              target: { type: "credential", slot: "api_key" },
            },
            {
              id: "token",
              label: "Token",
              input: "password",
              target: { type: "credential", slot: "token" },
            },
          ],
        },
      ],
    };
    manifest.operations[0].credentialSlot = "api_key";
    manifest.operations[0].credentialInjection = { in: "query", name: "key", format: "{token}" };
    manifest.operations[0].secondaryCredential = {
      slot: "token",
      injection: { in: "query", name: "token", format: "{token}" },
    };

    expect(oimManifestIssues(manifest)).toEqual([]);

    manifest.operations[0].secondaryCredential = {
      slot: "api_key",
      injection: { in: "query", name: "token", format: "{token}" },
    };
    expect(oimManifestIssues(manifest)).toContain(
      "operations: current-weather secondary credential must use a distinct slot and location"
    );

    manifest.operations[0].secondaryCredential = {
      slot: "token",
      injection: { in: "query", name: "key", format: "{token}" },
    };
    expect(oimManifestIssues(manifest)).toContain(
      "operations: current-weather secondary credential must use a distinct slot and location"
    );
  });
});

describe("OIM semantic compatibility", () => {
  it("accepts a minor release that adds an optional request property and output field", () => {
    const previous = valid();
    previous.operations[0].requestSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    jsonResponse(previous).schema = {
      type: "object",
      properties: { temperature: { type: "number" } },
    };

    const next = structuredClone(previous);
    next.metadata.version = "1.3.0";
    next.operations[0].requestSchema = {
      type: "object",
      properties: {
        city: { type: "string" },
        units: { type: "string" },
      },
      required: ["city"],
    };
    jsonResponse(next).schema = {
      type: "object",
      properties: {
        temperature: { type: "number" },
        conditions: { type: "string" },
      },
    };

    expect(oimCompatibilityIssues(previous, next)).toEqual([]);
  });

  it("rejects a same-major release that removes an operation or adds a required input", () => {
    const previous = valid();
    previous.operations[0].requestSchema = {
      type: "object",
      properties: { city: { type: "string" } },
    };

    const removed = structuredClone(previous);
    removed.metadata.version = "1.3.0";
    removed.operations = [];
    expect(oimCompatibilityIssues(previous, removed)).toContain(
      "operations: current-weather was removed"
    );

    const stricter = structuredClone(previous);
    stricter.metadata.version = "1.3.0";
    stricter.operations[0].requestSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    expect(oimCompatibilityIssues(previous, stricter)).toContain(
      "operations: current-weather request added required property city"
    );
  });

  it("rejects a newly required input and a narrower response projection", () => {
    const previous = valid();
    if (previous.operations[0].response.mode === "binary") throw new Error("fixture");
    previous.operations[0].response.projection = ["/temperature", "/conditions"];

    const next = structuredClone(previous);
    next.metadata.version = "1.3.0";
    next.operations[0].requestSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    if (next.operations[0].response.mode === "binary") throw new Error("fixture");
    next.operations[0].response.projection = ["/temperature"];
    next.operations[0].response.maxBytes = 1024;

    expect(oimCompatibilityIssues(previous, next)).toEqual([
      "operations: current-weather request added required property city",
      "operations: current-weather response projection removed /conditions",
      "operations: current-weather response maxBytes was reduced",
    ]);
  });

  it("rejects nested input restrictions and widened output contracts", () => {
    const previous = valid();
    previous.operations[0].requestSchema = {
      type: "object",
      properties: {
        location: {
          type: "object",
          properties: { city: { type: "string" } },
        },
        units: { type: "string", enum: ["metric", "imperial"] },
      },
    };
    jsonResponse(previous).schema = {
      type: "object",
      properties: { temperature: { type: "number" } },
      required: ["temperature"],
    };

    const next = structuredClone(previous);
    next.metadata.version = "1.3.0";
    next.operations[0].requestSchema = {
      type: "object",
      properties: {
        location: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        units: { type: "string", enum: ["metric"] },
      },
    };
    jsonResponse(next).schema = {
      type: "object",
      properties: { temperature: { type: "number" } },
    };

    expect(oimCompatibilityIssues(previous, next)).toEqual([
      "operations: current-weather request.location added required property city",
      "operations: current-weather request.units narrowed enum value imperial",
      "operations: current-weather response removed required property temperature",
    ]);
  });

  it("rejects required fields without properties and changed local schema definitions", () => {
    const previous = valid();
    previous.operations[0].requestSchema = { type: "object" };

    const required = structuredClone(previous);
    required.metadata.version = "1.3.0";
    required.operations[0].requestSchema = {
      type: "object",
      required: ["token"],
    };
    expect(oimCompatibilityIssues(previous, required)).toContain(
      "operations: current-weather request added required property token"
    );

    previous.operations[0].requestSchema = {
      $ref: "#/$defs/value",
      $defs: { value: { type: "string" } },
    };
    const changedDefinition = structuredClone(previous);
    changedDefinition.metadata.version = "1.3.0";
    changedDefinition.operations[0].requestSchema = {
      $ref: "#/$defs/value",
      $defs: { value: { type: "integer" } },
    };
    expect(oimCompatibilityIssues(previous, changedDefinition)).toContain(
      "operations: current-weather request changed $defs incompatibly"
    );
  });

  it("fails closed for changed JSON Schema keywords that need special variance rules", () => {
    const previous = valid();
    previous.operations[0].requestSchema = {
      type: "array",
      items: true,
      multipleOf: 1,
    };

    const next = structuredClone(previous);
    next.metadata.version = "1.3.0";
    next.operations[0].requestSchema = {
      type: "array",
      items: false,
      multipleOf: 2,
    };

    expect(oimCompatibilityIssues(previous, next)).toEqual(
      expect.arrayContaining([
        "operations: current-weather request changed multipleOf incompatibly",
        "operations: current-weather request changed items incompatibly",
      ])
    );
  });

  it("requires breaking changes to use a new major version", () => {
    const next = valid();
    next.metadata.version = "2.0.0";
    expect(oimCompatibilityIssues(valid(), next)).toEqual([
      "metadata.version: compatibility can only be checked within major version 1",
    ]);
  });
});

describe("OIM conformance claims", () => {
  it("emits profile versions as string enums", () => {
    expect(OimConformanceClaimSchema.properties.profiles.properties.core).toMatchObject({
      type: "string",
      enum: [...OIM_CORE_PROFILE_VERSIONS],
    });
  });

  it("requires every case for each claimed profile", () => {
    const claim = {
      oimVersion: "1.0",
      runtime: { name: "TulipFarm", version: "1.0.0" },
      profiles: { core: "1.0" },
      passedCases: OIM_CONFORMANCE_CASES.core.slice(0, -1),
    } as const;

    expect(oimConformanceIssues(claim)).toEqual([
      `passedCases: missing ${OIM_CONFORMANCE_CASES.core.at(-1)}`,
    ]);
  });

  it("accepts an exact complete Core claim", () => {
    expect(
      oimConformanceIssues({
        oimVersion: "1.0",
        runtime: { name: "TulipFarm", version: "1.0.0" },
        profiles: { core: "1.0" },
        passedCases: [...OIM_CONFORMANCE_CASES.core],
      })
    ).toEqual([]);
  });
});

function withEvents(overrides: Record<string, unknown> = {}): OimManifest {
  const manifest = valid();
  return {
    ...manifest,
    profiles: { ...manifest.profiles, events: "1.0" },
    events: {
      path: "/weather",
      verification: {
        scheme: "hmac_sha256",
        secretSlot: "webhook_secret",
        signatureHeader: "x-signature",
        signatureEncoding: "hex",
      },
      deduplication: { kind: "delivery_id_header", header: "x-delivery-id" },
      eventTypes: [
        {
          type: "forecast.updated",
          selector: { pointer: "/type", equals: "forecast_updated" },
          schema: { type: "object" },
        },
      ],
      ...overrides,
    },
  } as OimManifest;
}

/** Every issue here is a manifest that validates structurally but verifies nothing at runtime. */
describe("OIM Events profile", () => {
  it("accepts a declared webhook with no bespoke route", () => {
    expect(oimManifestIssues(withEvents())).toEqual([]);
    expect(validateOimManifest(withEvents())).toEqual(withEvents());
  });

  it("requires the events profile to be declared alongside the section", () => {
    const manifest = withEvents();
    const issues = oimManifestIssues({ ...manifest, profiles: { core: "1.0" } });
    expect(issues).toContain('profiles: events "1.0" is required when events are declared');
  });

  it("refuses a signed scheme with nothing to read the signature from", () => {
    const manifest = withEvents();
    const events = { ...manifest.events, verification: { scheme: "ed25519", secretSlot: "key" } };
    expect(oimManifestIssues({ ...manifest, events } as OimManifest)).toContain(
      "events: ed25519 requires signatureHeader"
    );
  });

  it("refuses a canonical signing input for a scheme that signs nothing", () => {
    const manifest = withEvents();
    const events = {
      ...manifest.events,
      verification: {
        scheme: "shared_secret",
        secretSlot: "webhook_secret",
        signatureHeader: "x-token",
        signingInput: "{body}",
      },
    };
    expect(oimManifestIssues({ ...manifest, events } as OimManifest)).toContain(
      "events: shared_secret does not sign a canonical input"
    );
  });

  it("refuses a signing template naming a timestamp the runtime cannot read", () => {
    // Without the header the template renders an empty timestamp, and every signature matches a
    // body signed at any moment — the replay window would exist only on paper.
    const manifest = withEvents();
    const events = {
      ...manifest.events,
      verification: {
        scheme: "hmac_sha256",
        secretSlot: "webhook_secret",
        signatureHeader: "x-signature",
        signingInput: "{timestamp}.{body}",
      },
    };
    expect(oimManifestIssues({ ...manifest, events } as OimManifest)).toContain(
      "events: signingInput names {timestamp} but no timestampHeader is declared"
    );
  });

  it("refuses a tolerance that governs nothing", () => {
    const manifest = withEvents();
    const events = {
      ...manifest.events,
      verification: { ...manifest.events?.verification, toleranceSeconds: 300 },
    };
    expect(oimManifestIssues({ ...manifest, events } as OimManifest)).toContain(
      "events: toleranceSeconds has no effect without a timestampHeader"
    );
  });

  it("caps the replay window rather than letting a manifest disable it", () => {
    const manifest = withEvents();
    const events = {
      ...manifest.events,
      verification: {
        ...manifest.events?.verification,
        timestampHeader: "x-timestamp",
        toleranceSeconds: 86_400,
      },
    };
    expect(() => validateOimManifest({ ...manifest, events })).toThrow(TulipFarmValidationError);
  });

  it("keeps issuer and audience to the one scheme that has them", () => {
    const manifest = withEvents();
    const events = {
      ...manifest.events,
      verification: { ...manifest.events?.verification, issuer: "https://provider.example" },
    };
    expect(oimManifestIssues({ ...manifest, events } as OimManifest)).toContain(
      "events: issuer and audience apply only to jwt"
    );
  });

  it("requires a deduplication key wherever one is claimed", () => {
    const manifest = withEvents();
    expect(
      oimManifestIssues({
        ...manifest,
        events: { ...manifest.events, deduplication: { kind: "delivery_id_header" } },
      } as OimManifest)
    ).toContain("events: delivery_id_header requires header");
    expect(
      oimManifestIssues({
        ...manifest,
        events: { ...manifest.events, deduplication: { kind: "body_pointer" } },
      } as OimManifest)
    ).toContain("events: body_pointer requires bodyPointer");
  });

  it("makes an author say `none` rather than leave deduplication out", () => {
    // Omission is not a decision that retries are safe to run twice, and the difference matters
    // when the event books a payment.
    const manifest = withEvents();
    const { deduplication: _dropped, ...events } = manifest.events ?? {};
    expect(() => validateOimManifest({ ...manifest, events })).toThrow(TulipFarmValidationError);
  });

  it("refuses a handshake with nothing to echo", () => {
    const manifest = withEvents({ handshake: { kind: "echo_body_pointer" } });
    expect(oimManifestIssues(manifest)).toContain("events: echo_body_pointer requires bodyPointer");
  });

  it("refuses a selector that matches every delivery", () => {
    const manifest = withEvents({
      eventTypes: [{ type: "any", selector: { pointer: "/type" }, schema: { type: "object" } }],
    });
    expect(oimManifestIssues(manifest)).toContain("events: any selector needs equals or matches");
  });

  it("refuses a selector pattern that could stall the inbox", () => {
    const manifest = withEvents({
      eventTypes: [
        {
          type: "slow",
          selector: { pointer: "/type", matches: "(a+)+$" },
          schema: { type: "object" },
        },
      ],
    });
    expect(oimManifestIssues(manifest)).toContain(
      "events: slow selector pattern is not a safe regular expression"
    );
  });

  it("refuses a normalizer no hook exports", () => {
    const manifest = withEvents({
      eventTypes: [
        {
          type: "forecast.updated",
          selector: { pointer: "/type", equals: "forecast_updated" },
          schema: { type: "object" },
          normalize: "missingNormalizer",
        },
      ],
    });
    expect(oimManifestIssues(manifest)).toContain(
      "events: forecast.updated normalizes with missingNormalizer, which no response_normalize hook exports"
    );
  });

  it("refuses to hand the signature header to a hook", () => {
    // Withholding it is the whole reason the safe-header list exists: a hook that can read the
    // signature can log it, and a logged signature is a replayable delivery.
    const manifest = withEvents({
      eventTypes: [
        {
          type: "forecast.updated",
          selector: { pointer: "/type", equals: "forecast_updated" },
          schema: { type: "object" },
          safeHeaders: ["X-Signature"],
        },
      ],
    });
    expect(oimManifestIssues(manifest)).toContain(
      "events: forecast.updated may not expose the signature header to a hook"
    );
  });

  it("refuses a duplicate event type", () => {
    const eventType = {
      type: "forecast.updated",
      selector: { pointer: "/type", equals: "forecast_updated" },
      schema: { type: "object" },
    };
    expect(oimManifestIssues(withEvents({ eventTypes: [eventType, eventType] }))).toContain(
      "events: duplicate event type forecast.updated"
    );
  });

  it("refuses a verification scheme outside the trusted suite", () => {
    // A scheme an author could name freely is a scheme the host cannot audit.
    const manifest = withEvents();
    const events = {
      ...manifest.events,
      verification: { scheme: "custom_hmac", secretSlot: "s", signatureHeader: "x-sig" },
    };
    expect(() => validateOimManifest({ ...manifest, events })).toThrow(TulipFarmValidationError);
  });

  it("refuses a webhook path that is not confined to the deployment's ingress base", () => {
    expect(() => validateOimManifest(withEvents({ path: "https://evil.example/steal" }))).toThrow(
      TulipFarmValidationError
    );
  });
});

function knowledgeManifest(overrides: Record<string, unknown> = {}): OimManifest {
  const manifest = valid();
  return {
    ...manifest,
    profiles: { ...manifest.profiles, knowledge: "1.0" },
    operations: [
      ...manifest.operations,
      {
        id: "list-pages",
        name: "list_pages",
        description: "List pages in a space.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/rest/content",
          parameters: [
            { name: "spaceKey", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string" } },
          ],
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
        pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/next" },
      },
      {
        id: "get-page",
        name: "get_page",
        description: "Read one page body.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/rest/content/{id}",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 1_048_576 },
      },
      {
        id: "get-restrictions",
        name: "get_restrictions",
        description: "Read the readers of one page.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/rest/content/{id}/restriction",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 65_536 },
      },
      {
        id: "get-user",
        name: "get_user",
        description: "Read one provider user.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/rest/user",
          parameters: [{ name: "accountId", in: "query", schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
      {
        id: "get-group",
        name: "get_group",
        description: "Read one provider group.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/rest/group",
          parameters: [{ name: "groupId", in: "query", schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
    knowledge: {
      sourceKinds: [{ id: "space", label: "Space" }],
      list: {
        operationId: "list-pages",
        scopeParameter: "spaceKey",
        itemsPointer: "/results",
        mapping: { itemId: "/id", revision: "/version/number", title: "/title" },
        cursor: { kind: "operation_pagination" },
      },
      content: {
        operationId: "get-page",
        itemParameter: "id",
        mapping: { content: "/body/storage/value" },
      },
      acl: {
        mode: "item",
        operationId: "get-restrictions",
        itemParameter: "id",
        entriesPointer: "/results",
        entry: {
          kindPointer: "/type",
          kindValues: { user: ["known"], group: ["group"] },
          providerUserId: "/accountId",
          providerGroupId: "/id",
        },
      },
      identity: {
        user: {
          operationId: "get-user",
          idParameter: "accountId",
          mapping: { providerId: "/accountId" },
        },
        group: {
          operationId: "get-group",
          idParameter: "groupId",
          mapping: { providerId: "/id" },
        },
      },
      deletion: { kind: "absent_from_full_list" },
      ...overrides,
    },
  } as OimManifest;
}

/** The Knowledge profile describes indexing. Every rule here stops a sync that would widen access. */
describe("OIM Knowledge profile", () => {
  it("accepts a complete declaration that starts no indexing", () => {
    expect(oimManifestIssues(knowledgeManifest())).toEqual([]);
    expect(validateOimManifest(knowledgeManifest())).toEqual(knowledgeManifest());
  });

  it("accepts bounded context arguments, scalar joins, and scalar ACL entries", () => {
    const manifest = knowledgeManifest();
    const operations = manifest.operations.map((operation) => {
      if (
        operation.id !== "get-page" ||
        operation.source.type !== "http" ||
        operation.source.contentType !== undefined
      ) {
        return operation;
      }
      return {
        ...operation,
        source: {
          ...operation.source,
          parameters: [
            ...(operation.source.parameters ?? []),
            { name: "channel", in: "query" as const, schema: { type: "string" } },
          ],
        },
      };
    });
    const knowledge = manifest.knowledge;
    const portable = {
      ...manifest,
      profiles: { ...manifest.profiles, knowledge: "1.1" },
      operations,
      knowledge: {
        ...knowledge,
        list: {
          ...knowledge?.list,
          mapping: {
            itemFields: {
              channel: { source: "scope" },
              page_id: { source: "item", pointer: "/id" },
            },
            itemIdentity: ["channel", "page_id"],
            revision: "/version/number",
            title: "/title",
          },
        },
        content: {
          operationId: "get-page",
          parameters: { id: "page_id", channel: "channel" },
          mapping: {
            content: {
              itemsPointer: "/messages",
              itemPointer: "/text",
              separator: "\n",
            },
          },
        },
        acl: {
          mode: "scope",
          operationId: "get-restrictions",
          scopeParameter: "id",
          entriesPointer: "/members",
          entry: { defaultKind: "user", providerUserId: "" },
        },
        liveAuthorization: {
          operationId: "get-restrictions",
          parameters: { id: "channel" },
          principalSet: { entriesPointer: "/members", principalIdPointer: "" },
        },
      },
    } as OimManifest;

    expect(oimManifestIssues(portable)).toEqual([]);
    expect(validateOimManifest(portable)).toEqual(portable);
  });

  it("refuses a parameter binding to an unknown item field", () => {
    const manifest = knowledgeManifest();
    const content = {
      ...manifest.knowledge?.content,
      parameters: { id: "missing" },
    };
    expect(
      oimManifestIssues({
        ...knowledgeManifest({ content }),
        profiles: { ...manifest.profiles, knowledge: "1.1" },
      })
    ).toContain("knowledge: content parameter id references unknown item field missing");
  });

  it("refuses a field parameter the operation does not declare", () => {
    const manifest = knowledgeManifest();
    const content = {
      ...manifest.knowledge?.content,
      parameters: { channel: "page_id" },
    };
    expect(
      oimManifestIssues({
        ...knowledgeManifest({
          list: {
            ...manifest.knowledge?.list,
            mapping: {
              ...manifest.knowledge?.list.mapping,
              itemFields: { page_id: { source: "item", pointer: "/id" } },
            },
          },
          content,
        }),
        profiles: { ...manifest.profiles, knowledge: "1.1" },
      })
    ).toContain("knowledge: content operation get-page declares no parameter channel");
  });

  it("refuses an ambiguous live authorization result mapping", () => {
    const liveAuthorization = {
      operationId: "get-restrictions",
      itemParameter: "id",
      allowedPointer: "/allowed",
      principalSet: { entriesPointer: "/members", principalIdPointer: "" },
    };
    const manifest = knowledgeManifest({ liveAuthorization });
    expect(
      oimManifestIssues({
        ...manifest,
        profiles: { ...manifest.profiles, knowledge: "1.1" },
      })
    ).toContain(
      "knowledge: liveAuthorization requires exactly one of allowedPointer or principalSet"
    );
  });

  it("keeps Knowledge 1.1 fields out of a 1.0 declaration", () => {
    const manifest = knowledgeManifest();
    const list = {
      ...manifest.knowledge?.list,
      mapping: {
        ...manifest.knowledge?.list.mapping,
        itemFields: { page_id: { source: "item" as const, pointer: "/id" } },
      },
    };
    expect(oimManifestIssues(knowledgeManifest({ list }))).toContain(
      'profiles: knowledge "1.1" is required for list.mapping.itemFields'
    );
  });

  it("refuses an unknown field in the ordered item identity", () => {
    const manifest = knowledgeManifest();
    const list = {
      ...manifest.knowledge?.list,
      mapping: {
        itemFields: { page_id: { source: "item" as const, pointer: "/id" } },
        itemIdentity: ["missing"],
      },
    };
    expect(
      oimManifestIssues({
        ...knowledgeManifest({ list }),
        profiles: { ...manifest.profiles, knowledge: "1.1" },
      })
    ).toContain("knowledge: list itemIdentity references unknown item field missing");
  });

  it("allows deletion parameters to use only scope-projected fields", () => {
    const manifest = knowledgeManifest();
    const list = {
      ...manifest.knowledge?.list,
      mapping: {
        ...manifest.knowledge?.list.mapping,
        itemFields: { page_id: { source: "item" as const, pointer: "/id" } },
      },
    };
    const deletion = {
      kind: "operation" as const,
      operationId: "list-pages",
      parameters: { spaceKey: "page_id" },
      itemsPointer: "/removed",
      itemIdPointer: "/id",
    };
    expect(
      oimManifestIssues({
        ...knowledgeManifest({ list, deletion }),
        profiles: { ...manifest.profiles, knowledge: "1.1" },
      })
    ).toContain("knowledge: deletion parameter spaceKey requires scope item field page_id");
  });

  it("requires the knowledge profile to be declared alongside the section", () => {
    const manifest = knowledgeManifest();
    expect(oimManifestIssues({ ...manifest, profiles: { core: "1.0" } })).toContain(
      'profiles: knowledge "1.0" or "1.1" is required when knowledge is declared'
    );
  });

  it("rejects an unknown field rather than silently ignoring it", () => {
    const manifest = knowledgeManifest();
    expect(() =>
      validateOimManifest({
        ...manifest,
        knowledge: { ...manifest.knowledge, sync: "hourly" },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("refuses a role that names an operation the manifest never declares", () => {
    expect(
      oimManifestIssues(
        knowledgeManifest({
          content: { operationId: "missing", itemParameter: "id", mapping: { content: "/body" } },
        })
      )
    ).toContain("knowledge: content references undeclared operation missing");
  });

  it("refuses a writing operation in a read-only role", () => {
    const manifest = knowledgeManifest();
    const operations = manifest.operations.map((operation) =>
      operation.id === "get-page" ? { ...operation, effect: "delete" as const } : operation
    );
    expect(oimManifestIssues({ ...manifest, operations })).toContain(
      "knowledge: content operation get-page is delete, but Knowledge sync is read-only"
    );
  });

  it("refuses a role parameter the operation does not accept", () => {
    expect(
      oimManifestIssues(
        knowledgeManifest({
          content: { operationId: "get-page", itemParameter: "pageId", mapping: { content: "/b" } },
        })
      )
    ).toContain("knowledge: content operation get-page declares no parameter pageId");
  });

  it("refuses operation pagination resume against an operation that does not paginate", () => {
    const manifest = knowledgeManifest();
    const operations = manifest.operations.map((operation) =>
      operation.id === "list-pages" ? { ...operation, pagination: undefined } : operation
    );
    expect(oimManifestIssues({ ...manifest, operations } as OimManifest)).toContain(
      "knowledge: list resumes from operation pagination, but list-pages declares no pagination"
    );
  });

  it("requires a response_pointer cursor to say where it reads and writes back", () => {
    const manifest = knowledgeManifest();
    const list = { ...manifest.knowledge?.list, cursor: { kind: "response_pointer" } };
    expect(oimManifestIssues(knowledgeManifest({ list }))).toContain(
      "knowledge: response_pointer cursor requires pointer and requestParameter"
    );
  });

  it("accepts a response_pointer cursor that feeds a declared parameter", () => {
    const manifest = knowledgeManifest();
    const list = {
      ...manifest.knowledge?.list,
      cursor: { kind: "response_pointer", pointer: "/lastModified", requestParameter: "since" },
    };
    expect(oimManifestIssues(knowledgeManifest({ list }))).toEqual([]);
  });

  it("refuses a cursorless walk that has no way to notice a deletion", () => {
    const manifest = knowledgeManifest();
    const list = { ...manifest.knowledge?.list, cursor: { kind: "none" } };
    expect(oimManifestIssues(knowledgeManifest({ list, deletion: { kind: "none" } }))).toContain(
      "knowledge: cursor none re-reads the whole source, so deletion must be absent_from_full_list"
    );
  });

  it("refuses an ACL entry that identifies nobody", () => {
    const manifest = knowledgeManifest();
    const acl = {
      ...manifest.knowledge?.acl,
      entry: { defaultKind: "user" },
    };
    expect(oimManifestIssues(knowledgeManifest({ acl }))).toContain(
      "knowledge: acl entry maps no principal identifier, so readers cannot be resolved"
    );
  });

  it("refuses an ACL entry with no way to tell a user from a group", () => {
    const manifest = knowledgeManifest();
    const acl = { ...manifest.knowledge?.acl, entry: { providerUserId: "/accountId" } };
    expect(oimManifestIssues(knowledgeManifest({ acl }))).toContain(
      "knowledge: acl entry needs kindPointer or defaultKind"
    );
  });

  it("refuses one provider value that means two different principal kinds", () => {
    const manifest = knowledgeManifest();
    const acl = {
      ...manifest.knowledge?.acl,
      entry: {
        kindPointer: "/type",
        kindValues: { user: ["known"], group: ["known"] },
        providerUserId: "/accountId",
      },
    };
    expect(oimManifestIssues(knowledgeManifest({ acl }))).toContain(
      "knowledge: acl kind value known maps to both user and group"
    );
  });

  it("refuses group grants that nothing can expand into members", () => {
    expect(oimManifestIssues(knowledgeManifest({ identity: undefined }))).toContain(
      "knowledge: acl entry grants to groups, but no identity.group lookup can expand them"
    );
  });

  it("refuses an email mapping the provider never marks verified", () => {
    const manifest = knowledgeManifest();
    const identity = {
      ...manifest.knowledge?.identity,
      user: {
        operationId: "get-user",
        idParameter: "accountId",
        mapping: { providerId: "/accountId", email: "/email" },
      },
    };
    expect(oimManifestIssues(knowledgeManifest({ identity }))).toContain(
      "knowledge: identity.user maps email without emailVerified, so no address can be trusted for matching"
    );
  });

  it("has no way to match on a display name at all", () => {
    const manifest = knowledgeManifest();
    const identity = {
      ...manifest.knowledge?.identity,
      user: {
        operationId: "get-user",
        idParameter: "accountId",
        mapping: { providerId: "/accountId", displayName: "/displayName" },
      },
    };
    expect(() => validateOimManifest(knowledgeManifest({ identity }))).toThrow(
      TulipFarmValidationError
    );
  });

  it("requires a deleted flag when deletion is read from the list", () => {
    expect(oimManifestIssues(knowledgeManifest({ deletion: { kind: "list_flag" } }))).toContain(
      "knowledge: list_flag deletion requires list.mapping.deleted"
    );
  });

  it("accepts a deleted flag the list actually maps", () => {
    const manifest = knowledgeManifest();
    const list = {
      ...manifest.knowledge?.list,
      mapping: { ...manifest.knowledge?.list.mapping, deleted: "/archived" },
    };
    expect(oimManifestIssues(knowledgeManifest({ list, deletion: { kind: "list_flag" } }))).toEqual(
      []
    );
  });

  it("refuses a deletion kind that names an operation it never calls", () => {
    expect(
      oimManifestIssues(
        knowledgeManifest({ deletion: { kind: "absent_from_full_list", operationId: "get-page" } })
      )
    ).toContain("knowledge: deletion absent_from_full_list names an operation it never calls");
  });

  it("requires an operation deletion sweep to say what it reads", () => {
    const issues = oimManifestIssues(
      knowledgeManifest({ deletion: { kind: "operation", operationId: "list-pages" } })
    );
    expect(issues).toContain("knowledge: operation deletion requires operationId and itemsPointer");
  });

  it("refuses a discovery mapping with no discovery operation", () => {
    expect(
      oimManifestIssues(
        knowledgeManifest({
          sourceKinds: [{ id: "space", label: "Space", discoverItemsPointer: "/results" }],
        })
      )
    ).toContain(
      "knowledge: source kind space maps discovery output but names no discovery operation"
    );
  });

  it("refuses a guide file the package never declares", () => {
    expect(oimManifestIssues(knowledgeManifest({ guideFile: "docs/knowledge.md" }))).toContain(
      "knowledge: guideFile docs/knowledge.md is not a declared file"
    );
  });

  it("refuses a guide file declared under another role", () => {
    const manifest = knowledgeManifest({ guideFile: "hooks/map.js" });
    const files = [
      { path: "hooks/map.js", role: "hook" as const, sha256: "a".repeat(64), bytes: 12 },
    ];
    expect(oimManifestIssues({ ...manifest, files })).toContain(
      "knowledge: guideFile hooks/map.js is declared with role hook, not guide"
    );
  });
});

describe("templated base URLs", () => {
  function templated(overrides: Partial<OimManifest["auth"]> = {}): OimManifest {
    const base = valid();
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
        ...overrides,
      },
      operations: base.operations.map((operation) => ({
        ...operation,
        source: { ...operation.source, baseUrl: "https://{site}/v1" },
      })) as OimManifest["operations"],
    };
  }

  it("accepts a placeholder backed by a configuration field and allowed hosts", () => {
    expect(validateOimManifest(templated())).toBeDefined();
    expect(oimManifestIssues(templated())).toEqual([]);
  });

  it("reports a placeholder no configuration field declares", () => {
    const manifest = templated({ configurationFields: [] });
    expect(oimManifestIssues(manifest)).toContainEqual(
      expect.stringContaining("which no configuration field declares")
    );
  });

  it("reports a templated origin with no declared host bound", () => {
    const manifest = templated({ allowedOriginHosts: undefined });
    expect(oimManifestIssues(manifest)).toContainEqual(
      expect.stringContaining("without auth.allowedOriginHosts")
    );
  });

  it("reads the placeholder field name", () => {
    expect(oimOriginPlaceholder("https://{site}/v1")).toBe("site");
    expect(oimOriginPlaceholder("https://api.weather.example")).toBeUndefined();
  });

  it("matches a wildcard host without matching its bare parent", () => {
    expect(oimOriginAllowed("acme.weather.example", ["*.weather.example"])).toBe(true);
    expect(oimOriginAllowed("weather.example", ["*.weather.example"])).toBe(false);
    expect(oimOriginAllowed("api.weather.example", ["api.weather.example"])).toBe(true);
    expect(oimOriginAllowed("evil.example", ["*.weather.example"])).toBe(false);
  });
});
