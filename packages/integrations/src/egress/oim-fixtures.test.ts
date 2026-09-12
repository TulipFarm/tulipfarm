import type { OimManifest } from "@tulipfarm/schema";
import { oimFileDigest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { OIM_FIXTURE_INPUT_PAGE_TOKEN } from "./oim-fixture-codec";
import { runOimFixtures } from "./oim-fixtures";

const fixture = `version: 1
cases:
  - name: gets-weather
    operationId: get-weather
    request:
      city: London
    response:
      status: 200
      body:
        temperature: 18
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London
      result:
        temperature: 18
`;

function manifest(content = fixture): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    files: [{ path: "fixtures.yml", role: "fixture", sha256: oimFileDigest(content) }],
    operations: [
      {
        id: "get-weather",
        name: "get_weather",
        description: "Get weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/weather",
          parameters: [{ name: "city", in: "query", schema: { type: "string" } }],
        },
        response: { maxBytes: 1024, schema: { type: "object" } },
      },
    ],
  } as OimManifest;
}

describe("runOimFixtures", () => {
  it("uses per-case configuration for tenant hosts and configured path segments", async () => {
    const configuredFixture = `
version: 1
cases:
  - name: configured-read
    operationId: get-weather
    configuration:
      site: acme.example.com
      account_id: account-1
      shard: 3
      enabled: true
    request: {}
    response:
      status: 200
      body:
        item: { id: item-1 }
    expect:
      request:
        method: GET
        url: https://acme.example.com/accounts/account-1/shards/3/enabled/true/items
      result:
        item: { id: item-1 }
`;
    const configuredManifest = manifest(configuredFixture);
    const operation = configuredManifest.operations[0];
    if (operation?.source.type !== "http") throw new Error("expected HTTP operation");
    operation.source.baseUrl = "https://{site}";
    operation.source.path = "/accounts/{account_id}/shards/{shard}/enabled/{enabled}/items";
    operation.source.parameters = [
      {
        name: "account_id",
        in: "path",
        required: true,
        schema: { type: "string" },
        configurationField: "account_id",
      },
      {
        name: "shard",
        in: "path",
        required: true,
        schema: { type: "integer" },
        configurationField: "shard",
      },
      {
        name: "enabled",
        in: "path",
        required: true,
        schema: { type: "boolean" },
        configurationField: "enabled",
      },
    ];
    configuredManifest.profiles.core = "1.1";
    configuredManifest.profiles.auth = "1.0";
    configuredManifest.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [
        { id: "site", label: "Site", type: "url" },
        { id: "account_id", label: "Account", type: "string" },
        { id: "shard", label: "Shard", type: "integer" },
        { id: "enabled", label: "Enabled", type: "boolean" },
      ],
      allowedOriginHosts: ["*.example.com"],
      steps: [],
    };

    await expect(
      runOimFixtures(configuredManifest, new Map([["fixtures.yml", configuredFixture]]))
    ).resolves.toEqual([
      {
        fixture: "fixtures.yml",
        name: "configured-read",
        passed: true,
      },
    ]);
  });
  it("runs the compiled adapter against the recorded response and checks its request shape", async () => {
    await expect(runOimFixtures(manifest(), new Map([["fixtures.yml", fixture]]))).resolves.toEqual(
      [{ name: "gets-weather", fixture: "fixtures.yml", passed: true }]
    );
  });

  it("injects seeded opaque continuation state and emits a deterministic fixture token", async () => {
    const paginatedFixture = `version: 1
cases:
  - name: gets-weather-page
    operationId: get-weather
    request:
      city: London
      page_token: ${OIM_FIXTURE_INPUT_PAGE_TOKEN}
    response:
      status: 200
      body:
        temperature: 18
        nextCursor: next-secret-cursor
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London&cursor=old-secret-cursor
      result:
        temperature: 18
        next_page_token: fixture-continuation:1
`;
    const paginatedManifest = manifest(paginatedFixture);
    const operation = paginatedManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.pagination = {
      type: "cursor",
      requestParameter: "cursor",
      responsePath: "/nextCursor",
    };

    await expect(
      runOimFixtures(paginatedManifest, new Map([["fixtures.yml", paginatedFixture]]), {
        continuations: {
          "gets-weather-page": { cursor: "old-secret-cursor" },
        },
        now: () => 1_000,
      })
    ).resolves.toEqual([
      {
        fixture: "fixtures.yml",
        name: "gets-weather-page",
        passed: true,
      },
    ]);
  });

  it("validates paginated top-level arrays through the items envelope", async () => {
    const arrayFixture = `version: 1
cases:
  - name: lists-readings
    operationId: get-weather
    request:
      city: London
    response:
      status: 200
      body:
        - id: 1
        - id: 2
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London&page=1
      result:
        items:
          - id: 1
          - id: 2
        next_page_token: fixture-continuation:1
`;
    const arrayManifest = manifest(arrayFixture);
    const operation = arrayManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.pagination = { type: "page", requestParameter: "page" };
    operation.response = {
      maxBytes: operation.response.maxBytes,
      schema: {
        type: "array",
        items: { type: "object", properties: { id: { type: "integer" } } },
      },
    };

    await expect(
      runOimFixtures(arrayManifest, new Map([["fixtures.yml", arrayFixture]]))
    ).resolves.toEqual([
      {
        fixture: "fixtures.yml",
        name: "lists-readings",
        passed: true,
      },
    ]);
  });

  it("refuses per-case configuration that the manifest does not declare", async () => {
    const invalid = fixture.replace(
      "operationId: get-weather",
      "operationId: get-weather\n    configuration:\n      undeclared: value"
    );

    await expect(
      runOimFixtures(manifest(invalid), new Map([["fixtures.yml", invalid]]))
    ).resolves.toEqual([
      expect.objectContaining({
        name: "gets-weather",
        passed: false,
        error: expect.stringContaining("configuration field undeclared is not declared"),
      }),
    ]);
  });

  it("refuses per-case configuration with the wrong declared type", async () => {
    const invalid = fixture.replace(
      "operationId: get-weather",
      "operationId: get-weather\n    configuration:\n      shard: not-a-number"
    );
    const invalidManifest = manifest(invalid);
    invalidManifest.profiles.auth = "1.0";
    invalidManifest.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [{ id: "shard", label: "Shard", type: "integer" }],
      steps: [],
    };

    await expect(
      runOimFixtures(invalidManifest, new Map([["fixtures.yml", invalid]]))
    ).resolves.toEqual([
      expect.objectContaining({
        name: "gets-weather",
        passed: false,
        error: expect.stringContaining("configuration field shard must be integer"),
      }),
    ]);
  });

  it("refuses a credential slot even when it is also declared as configuration", async () => {
    const unsafe = fixture.replace(
      "operationId: get-weather",
      "operationId: get-weather\n    configuration:\n      api_key: not-a-real-key"
    );
    const unsafeManifest = manifest(unsafe);
    unsafeManifest.profiles.auth = "1.0";
    unsafeManifest.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [{ id: "api_key", label: "Unsafe duplicate", type: "string" }],
      steps: [],
    };

    await expect(
      runOimFixtures(unsafeManifest, new Map([["fixtures.yml", unsafe]]))
    ).resolves.toEqual([
      expect.objectContaining({
        name: "gets-weather",
        passed: false,
        error: expect.stringContaining("configuration field api_key is a credential slot"),
      }),
    ]);
  });

  it("passes when the runtime returns the declared typed failure", async () => {
    const failureFixture = `version: 1
cases:
  - name: missing-weather
    operationId: get-weather
    request:
      city: Atlantis
    response:
      status: 404
      body:
        error: not found
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=Atlantis
      expectedError:
        phase: before_dispatch
        code: provider_not_found
        retryable: false
`;

    await expect(
      runOimFixtures(manifest(failureFixture), new Map([["fixtures.yml", failureFixture]]))
    ).resolves.toEqual([{ name: "missing-weather", fixture: "fixtures.yml", passed: true }]);
  });

  it("turns a successful HTTP response that violates the Tool output schema into invalid_output", async () => {
    const invalidOutputFixture = `version: 1
cases:
  - name: rejects-provider-errors
    operationId: get-weather
    request:
      city: London
    response:
      status: 200
      body:
        errors:
          - rejected
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London
      expectedError:
        phase: after_dispatch
        code: invalid_output
        retryable: false
`;
    const invalidOutputManifest = manifest(invalidOutputFixture);
    const operation = invalidOutputManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.effect = "create";
    operation.response = {
      maxBytes: 1024,
      schema: {
        type: "object",
        properties: {
          errors: { type: "array", maxItems: 0 },
        },
        required: ["errors"],
      },
    };

    await expect(
      runOimFixtures(invalidOutputManifest, new Map([["fixtures.yml", invalidOutputFixture]]))
    ).resolves.toEqual([
      { name: "rejects-provider-errors", fixture: "fixtures.yml", passed: true },
    ]);
  });

  it("stores binary fixture responses through the runtime File port", async () => {
    const binaryFixture = `version: 1
cases:
  - name: downloads-export
    operationId: get-weather
    request:
      city: London
    response:
      status: 200
      headers:
        content-type: application/pdf
        content-disposition: attachment; filename="weather.pdf"
      body: fake-pdf
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London
      result:
        fileId: fixture-downloads-export-file
        summary:
          filename: weather.pdf
          mediaType: application/pdf
          sizeBytes: 8
          truncated: false
`;
    const binaryManifest = manifest(binaryFixture);
    const operation = binaryManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.response = { mode: "binary", maxBytes: 16 };

    await expect(
      runOimFixtures(binaryManifest, new Map([["fixtures.yml", binaryFixture]]))
    ).resolves.toEqual([{ name: "downloads-export", fixture: "fixtures.yml", passed: true }]);
  });

  it("refuses an oversized binary fixture before the File port stores it", async () => {
    const binaryFixture = `version: 1
cases:
  - name: rejects-large-export
    operationId: get-weather
    request:
      city: London
    response:
      status: 200
      headers:
        content-type: application/pdf
      body: fake-pdf
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London
      expectedError:
        phase: before_dispatch
        code: provider_error
        retryable: false
`;
    const binaryManifest = manifest(binaryFixture);
    const operation = binaryManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.response = { mode: "binary", maxBytes: 4 };

    await expect(
      runOimFixtures(binaryManifest, new Map([["fixtures.yml", binaryFixture]]))
    ).resolves.toEqual([{ name: "rejects-large-export", fixture: "fixtures.yml", passed: true }]);
  });

  it("executes OpenAPI fixtures through the runtime compiler and adapter", async () => {
    const openApiFixture = fixture
      .replace(
        "operationId: get-weather",
        "operationId: get-weather\n    configuration:\n      site: tenant.weather.example"
      )
      .replace(
        "https://api.weather.example/weather?city=London",
        "https://tenant.weather.example/v1/weather?city=London"
      );
    const document = `openapi: 3.0.3
servers:
  - url: https://api.weather.example/v1
paths:
  /weather:
    get:
      operationId: getWeather
      parameters:
        - name: city
          in: query
          required: true
          schema: { type: string }
      responses:
        "200":
          content:
            application/json:
              schema: { type: object }
`;
    const openApiManifest = manifest(openApiFixture);
    const operation = openApiManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.source = {
      type: "openapi",
      file: "openapi.yaml",
      operationId: "getWeather",
      baseUrl: "https://{site}/v1",
    };
    openApiManifest.profiles.auth = "1.0";
    openApiManifest.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [{ id: "site", label: "Site", type: "url" }],
      allowedOriginHosts: ["*.weather.example"],
      steps: [],
    };
    openApiManifest.files = [
      ...(openApiManifest.files ?? []),
      { path: "openapi.yaml", role: "openapi", sha256: oimFileDigest(document) },
    ];

    await expect(
      runOimFixtures(
        openApiManifest,
        new Map([
          ["fixtures.yml", openApiFixture],
          ["openapi.yaml", document],
        ])
      )
    ).resolves.toEqual([{ name: "gets-weather", fixture: "fixtures.yml", passed: true }]);
  });

  it("uses per-case configuration when compiling GraphQL fixture endpoints", async () => {
    const graphqlFixture = `version: 1
cases:
  - name: gets-shop
    operationId: get-weather
    configuration:
      shop: muskan.myshopify.com
    request: {}
    response:
      status: 200
      body:
        data:
          shop: { id: gid://shopify/Shop/1 }
    expect:
      request:
        method: POST
        url: https://muskan.myshopify.com/admin/api/graphql.json
      result:
        data:
          shop: { id: gid://shopify/Shop/1 }
`;
    const document = "query GetShop { shop { id } }\n";
    const graphqlManifest = manifest(graphqlFixture);
    const operation = graphqlManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.source = {
      type: "graphql",
      url: "https://{shop}/admin/api/graphql.json",
      operation: "GetShop",
      documentFile: "get-shop.graphql",
    };
    graphqlManifest.profiles.auth = "1.0";
    graphqlManifest.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [{ id: "shop", label: "Shop", type: "string" }],
      allowedOriginHosts: ["*.myshopify.com"],
      steps: [],
    };
    graphqlManifest.files = [
      ...(graphqlManifest.files ?? []),
      { path: "get-shop.graphql", role: "graphql", sha256: oimFileDigest(document) },
    ];

    await expect(
      runOimFixtures(
        graphqlManifest,
        new Map([
          ["fixtures.yml", graphqlFixture],
          ["get-shop.graphql", document],
        ])
      )
    ).resolves.toEqual([{ name: "gets-shop", fixture: "fixtures.yml", passed: true }]);
  });

  it.each(["credential", "credentials", "network", "clock", "now"])(
    "refuses the %s capability inside fixture configuration",
    async (capability) => {
      const unsafe = fixture.replace(
        "operationId: get-weather",
        `operationId: get-weather\n    configuration:\n      ${capability}: forbidden`
      );

      await expect(
        runOimFixtures(manifest(unsafe), new Map([["fixtures.yml", unsafe]]))
      ).resolves.toEqual([
        expect.objectContaining({
          name: "fixtures.yml",
          passed: false,
          error: expect.stringContaining(`fixture gets-weather refuses ${capability}`),
        }),
      ]);
    }
  );
});
