import { type OimConnection, type OimManifest, validateOimManifest } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { OimOperationConnectionResolver } from "./operation";
import { ConnectionResolver } from "./resolver";

const manifest = validateOimManifest({
  oimVersion: "1.0",
  kind: "Integration",
  metadata: {
    id: "weather",
    name: "Weather",
    version: "1.2.3",
    description: "Weather data.",
    license: "Apache-2.0",
  },
  profiles: { core: "1.0", auth: "1.0" },
  auth: {
    credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
    steps: [
      {
        id: "credentials",
        type: "fields",
        title: "Connect Weather",
        fields: [
          {
            id: "api_key",
            label: "API key",
            input: "password",
            target: { type: "credential", slot: "api_key" },
          },
        ],
      },
    ],
  },
  operations: [
    {
      id: "current",
      name: "current_weather",
      description: "Read weather.",
      effect: "read",
      identityMode: "shared_or_personal",
      credentialSlot: "api_key",
      credentialInjection: { in: "header", name: "x-api-key", format: "{token}" },
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://api.weather.example",
        path: "/current",
      },
      response: { schema: { type: "object" }, maxBytes: 16_384 },
    },
  ],
});
const operation = manifest.operations[0];

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    businessId: "business-1",
    id: "connection-1",
    integration: { id: "weather", majorVersion: 1 },
    label: "Weather",
    owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { api_key: "secret://credential-1" },
    health: { status: "healthy", checkedAt: "2026-09-05T00:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-05T00:00:00.000Z"),
    updatedAt: new Date("2026-09-05T00:00:00.000Z"),
    ...overrides,
  };
}

function resolver(value: PersistedConnection) {
  const reader = {
    findById: async () => value,
    listForOwner: async (
      _businessId: string,
      _integration: OimConnection["integration"],
      owner: OimConnection["owner"]
    ) => (owner.scope === value.owner.scope ? [value] : []),
    listForIntegration: async () => [value],
  };
  return new OimOperationConnectionResolver(
    new ConnectionResolver(reader, { canUse: async () => true }),
    () => new Date("2026-09-05T12:00:00.000Z")
  );
}

function request() {
  if (operation === undefined) throw new Error("expected operation");
  return {
    businessId: "business-1",
    manifest,
    operation,
    principal: { kind: "user", id: "user-1" },
    personalOwnerId: "user-1",
  };
}

describe("OimOperationConnectionResolver", () => {
  it("resolves a Connection for configuration-only tenant routing", async () => {
    const configuredManifest = {
      ...manifest,
      auth: {
        ...manifest.auth,
        configurationFields: [{ id: "site", label: "Site", type: "string" as const }],
        allowedOriginHosts: ["*.weather.example"],
      },
      operations: [
        {
          ...operation,
          credentialSlot: undefined,
          credentialInjection: undefined,
          source: {
            type: "http" as const,
            method: "GET" as const,
            baseUrl: "https://{site}",
            path: "/current",
          },
        },
      ],
    } as OimManifest;
    const configuredOperation = configuredManifest.operations[0];
    if (configuredOperation === undefined) throw new Error("expected operation");

    await expect(
      resolver(connection({ configuration: { site: "acme.weather.example" } })).resolve({
        businessId: "business-1",
        manifest: configuredManifest,
        operation: configuredOperation,
        principal: { kind: "user", id: "user-1" },
        personalOwnerId: "user-1",
      })
    ).resolves.toMatchObject({
      kind: "configured",
      connection: { id: "connection-1" },
    });
  });

  it("requires configuration for host-owned HTTP parameters", async () => {
    const configuredManifest = {
      ...manifest,
      auth: {
        ...manifest.auth,
        configurationFields: [
          {
            id: "user_agent",
            label: "User-Agent",
            type: "string" as const,
            required: true,
          },
        ],
      },
      operations: [
        {
          ...operation,
          credentialSlot: undefined,
          credentialInjection: undefined,
          source: {
            ...operation.source,
            parameters: [
              {
                name: "User-Agent",
                in: "header" as const,
                schema: { type: "string" as const },
                configurationField: "user_agent",
              },
            ],
          },
        },
      ],
    } as unknown as OimManifest;
    const configuredOperation = configuredManifest.operations[0];
    if (configuredOperation === undefined) throw new Error("expected operation");

    await expect(
      resolver(connection({ configuration: { user_agent: "tulipfarm:test" } })).resolve({
        businessId: "business-1",
        manifest: configuredManifest,
        operation: configuredOperation,
        principal: { kind: "user", id: "user-1" },
        personalOwnerId: "user-1",
      })
    ).resolves.toMatchObject({
      kind: "configured",
      connection: { id: "connection-1" },
    });
  });

  it("returns an exact Secret authority binding without plaintext", async () => {
    const result = await resolver(connection()).resolve(request());

    expect(result).toMatchObject({
      kind: "ready",
      credentialRef: "secret://credential-1",
      binding: {
        connectionId: "connection-1",
        integrationId: "weather",
        credentialSlot: "api_key",
        principalKind: "user",
        principalId: "user-1",
      },
    });
    expect(JSON.stringify(result)).not.toContain("plaintext");
  });

  it("refuses a revoked or mismatched Connection when reauthorizing a recorded binding", async () => {
    const result = await resolver(connection()).resolve(request());
    if (result.kind !== "ready") throw new Error("expected ready Connection");

    await expect(
      resolver(connection({ status: "revoked" })).reauthorize(
        "business-1",
        manifest,
        result.binding,
        result.credentialRef
      )
    ).resolves.toBe(false);
    await expect(
      resolver(connection({ integration: { id: "other", majorVersion: 1 } })).reauthorize(
        "business-1",
        manifest,
        result.binding,
        result.credentialRef
      )
    ).resolves.toBe(false);
  });

  it("returns typed outcomes for missing credentials and unhealthy Connections", async () => {
    await expect(resolver(connection({ secretBindings: {} })).resolve(request())).resolves.toEqual({
      kind: "credential_required",
      connectionId: "connection-1",
      credentialSlot: "api_key",
    });
    await expect(
      resolver(
        connection({
          health: { status: "action_required", checkedAt: "2026-09-05T00:00:00.000Z" },
        })
      ).resolve(request())
    ).resolves.toEqual({
      kind: "connection_unhealthy",
      connectionId: "connection-1",
      status: "action_required",
    });
    await expect(
      resolver(connection({ expiresAt: "2026-09-05T11:59:59.000Z" })).resolve(request())
    ).resolves.toEqual({
      kind: "connection_unhealthy",
      connectionId: "connection-1",
      status: "expired",
    });
  });

  it("maps missing and ambiguous selection to participant-safe outcomes", async () => {
    const missingReader = {
      findById: async () => null,
      listForOwner: async () => [],
      listForIntegration: async () => [],
    };
    const missing = new OimOperationConnectionResolver(
      new ConnectionResolver(missingReader, { canUse: async () => true })
    );
    await expect(missing.resolve(request())).resolves.toEqual({
      kind: "connection_required",
      candidates: [],
    });

    const first = connection({ id: "first", isDefault: false });
    const second = connection({
      id: "second",
      isDefault: false,
      owner: { scope: "organization" },
    });
    const ambiguousReader = {
      findById: async () => null,
      listForOwner: async (
        _businessId: string,
        _integration: OimConnection["integration"],
        owner: OimConnection["owner"]
      ) => (owner.scope === "personal" ? [first] : [second]),
      listForIntegration: async () => [first, second],
    };
    const ambiguous = new OimOperationConnectionResolver(
      new ConnectionResolver(ambiguousReader, { canUse: async () => true })
    );
    await expect(ambiguous.resolve(request())).resolves.toMatchObject({
      kind: "connection_ambiguous",
      candidates: [{ id: "first" }, { id: "second" }],
    });
  });
});
