import { ConnectionResolver, OimOperationConnectionResolver } from "@tulipfarm/integrations";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { type OimManifest, oimFileDigest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { PersistedConnection } from "@tulipfarm/storage";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { createIntegrationDraftConnectionTester } from "./draft-connection-tester";

function manifest(effect: OimManifest["operations"][number]["effect"] = "read"): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      description: "Acme health checks.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "token", label: "Token", kind: "api_key", required: true }],
      steps: [],
      healthCheckOperationId: "health",
    },
    operations: [
      {
        id: "health",
        name: "health",
        description: "Check the current connection.",
        effect,
        identityMode: "shared_only",
        credentialSlot: "token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: { type: "http", method: "GET", baseUrl: "https://api.acme.test", path: "/health" },
        response: {
          schema: {
            type: "object",
            properties: { ok: { const: true } },
            required: ["ok"],
          },
          maxBytes: 16_384,
        },
      },
    ],
  };
}

function connection(): PersistedConnection {
  return {
    id: "conn-1",
    integration: { id: "acme", majorVersion: 1 },
    label: "Acme",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { token: "secret://sec-conn-1-acme-token" },
    health: { status: "healthy" },
    expiresAt: null,
  } as unknown as PersistedConnection;
}

const requestContext = {
  userId: "user-1",
  subject: { kind: "user", id: "user-1" },
  runId: "run-1",
  toolCallId: "review-1",
  agentId: "forge",
};

function artifacts(): ArtifactService {
  return {
    read: async () => {
      throw new Error("no request artifact");
    },
  } as unknown as ArtifactService;
}

function secrets(
  value: string,
  onRead: () => void = () => undefined
): () => Promise<SecretsService> {
  return async () =>
    ({
      get: async () => {
        onRead();
        return value;
      },
      resolveCurrent: async () => {
        onRead();
        return { value, version: "1" };
      },
      revision: async () => "1",
    }) as unknown as SecretsService;
}

function connectionResolver(canUse: (principalId: string) => boolean) {
  const persisted = connection();
  return new OimOperationConnectionResolver(
    new ConnectionResolver(
      {
        findById: async (_businessId, id) => (id === persisted.id ? persisted : null),
        listForOwner: async () => [persisted],
        listForIntegration: async () => [persisted],
      },
      { canUse: async (principal) => canUse(principal.id) }
    )
  );
}

function tester(options: {
  readonly authorize?: () => Promise<unknown>;
  readonly canUse?: (principalId: string) => boolean;
  readonly grantTool?: boolean;
  readonly onSecretRead?: () => void;
  readonly onRequest?: (request: { readonly url: string; readonly headers: Headers }) => void;
  readonly responseBody?: unknown;
}) {
  return createIntegrationDraftConnectionTester({
    releaseTrust: {
      authorizeInstalledToolCompilation: options.authorize ?? (async () => ({})),
    },
    tooling: {
      businessId: "business-1",
      effects: new MemoryEffectStore(),
      connections: connectionResolver(options.canUse ?? (() => true)),
      secrets: secrets("secret-token", options.onSecretRead),
      http: {
        send: async (request) => {
          options.onRequest?.({
            url: request.url,
            headers: new Headers(request.headers),
          });
          return {
            status: 200,
            headers: {},
            body: options.responseBody ?? { ok: true, echoed_secret: "secret-token" },
          };
        },
      },
    },
    artifacts: artifacts(),
    agents: { resolve: () => ({ name: "forge" }) },
    authorityLayers: {
      resolvePrincipalLayer: async (name) => ({
        name,
        grants:
          options.grantTool === false
            ? []
            : [
                {
                  action: "integration.acme.health",
                  resourceType: "integration.acme",
                  effect: "allow",
                },
              ],
      }),
    },
  });
}

describe("live OIM draft Connection testing", () => {
  it("refuses unapproved reviewed bytes before resolving a Connection or Secret", async () => {
    const usedConnection = vi.fn(() => true);
    const readSecret = vi.fn();
    const send = vi.fn();
    const testConnection = tester({
      authorize: async () => {
        throw new Error("digest mismatch");
      },
      canUse: usedConnection,
      onSecretRead: readSecret,
      onRequest: send,
    });

    const result = await testConnection.test({
      manifest: manifest(),
      companions: new Map(),
      connectionId: "conn-1",
      requestContext,
    });

    expect(result).toEqual({
      connectionId: "conn-1",
      passed: false,
      operationId: "health",
      error:
        "This exact reviewed package is not installed and approved, so it cannot use an existing Connection.",
    });
    expect(usedConnection).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("uses the selected Connection through caller authorization and hides provider data", async () => {
    const usedBy: string[] = [];
    const requests: { readonly url: string; readonly headers: Headers }[] = [];
    const testConnection = tester({
      canUse: (principalId) => {
        usedBy.push(principalId);
        return true;
      },
      onRequest: (request) => requests.push(request),
    });

    const result = await testConnection.test({
      manifest: manifest(),
      companions: new Map(),
      connectionId: "conn-1",
      requestContext,
    });

    expect(result).toEqual({
      connectionId: "conn-1",
      passed: true,
      operationId: "health",
      status: "succeeded",
    });
    expect(usedBy).toEqual(["user-1", "user-1"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.acme.test/health");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret-token");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(requests[0]?.url).not.toContain("connection_id");
  });

  it("refuses a caller who cannot use the selected Connection before leasing its Secret", async () => {
    const readSecret = vi.fn();
    const send = vi.fn();
    const testConnection = tester({
      canUse: () => false,
      onSecretRead: readSecret,
      onRequest: send,
    });

    const result = await testConnection.test({
      manifest: manifest(),
      companions: new Map(),
      connectionId: "conn-1",
      requestContext,
    });

    expect(result).toEqual({
      connectionId: "conn-1",
      passed: false,
      operationId: "health",
      status: "succeeded",
      error: "The caller or selected Connection is not authorized for this health check.",
    });
    expect(readSecret).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a caller without Tool authority before resolving the selected Connection", async () => {
    const usedConnection = vi.fn(() => true);
    const readSecret = vi.fn();
    const send = vi.fn();
    const testConnection = tester({
      grantTool: false,
      canUse: usedConnection,
      onSecretRead: readSecret,
      onRequest: send,
    });

    const result = await testConnection.test({
      manifest: manifest(),
      companions: new Map(),
      connectionId: "conn-1",
      requestContext,
    });

    expect(result).toEqual({
      connectionId: "conn-1",
      passed: false,
      operationId: "health",
      status: "denied",
      error: "The caller or selected Connection is not authorized for this health check.",
    });
    expect(usedConnection).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    {
      source: {
        type: "graphql" as const,
        url: "https://api.acme.test/graphql",
        operation: "Health",
        documentFile: "health.graphql",
      },
      file: {
        path: "health.graphql",
        role: "graphql" as const,
        content: "query Health { health { ok } }\n",
      },
      responseBody: { data: { health: { ok: true } } },
      expectedUrl: "https://api.acme.test/graphql",
    },
    {
      source: {
        type: "openapi" as const,
        file: "openapi.yaml",
        operationId: "health",
      },
      file: {
        path: "openapi.yaml",
        role: "openapi" as const,
        content: `openapi: 3.0.3
servers:
  - url: https://api.acme.test
paths:
  /health:
    get:
      operationId: health
      responses:
        "200":
          content:
            application/json:
              schema: { type: object }
`,
      },
      responseBody: { ok: true },
      expectedUrl: "https://api.acme.test/health",
    },
  ])("uses the production $source.type compiler and adapter", async (variant) => {
    const reviewedManifest = manifest();
    const operation = reviewedManifest.operations[0];
    if (operation === undefined) throw new Error("expected operation");
    operation.source = variant.source;
    operation.response = { schema: { type: "object" }, maxBytes: 16_384 };
    reviewedManifest.files = [
      {
        path: variant.file.path,
        role: variant.file.role,
        sha256: oimFileDigest(variant.file.content),
      },
    ];
    const requests: string[] = [];
    const testConnection = tester({
      responseBody: variant.responseBody,
      onRequest: (request) => requests.push(request.url),
    });

    const result = await testConnection.test({
      manifest: reviewedManifest,
      companions: new Map([[variant.file.path, variant.file.content]]),
      connectionId: "conn-1",
      requestContext,
    });

    expect(result.passed).toBe(true);
    expect(requests).toEqual([variant.expectedUrl]);
  });

  it("refuses a mutating health-check declaration without authorizing or dispatching it", async () => {
    const authorize = vi.fn(async () => ({}));
    const send = vi.fn();
    const testConnection = tester({ authorize, onRequest: send });

    const result = await testConnection.test({
      manifest: manifest("update"),
      companions: new Map(),
      connectionId: "conn-1",
      requestContext,
    });

    expect(result).toEqual({
      connectionId: "conn-1",
      passed: false,
      operationId: "health",
      error: "A health-check operation must be read-only.",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
