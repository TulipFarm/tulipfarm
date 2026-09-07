import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { OimConnectError } from "./oim-connect";
import { runHealthCheck } from "./oim-connection-routes";

/**
 * The health check is the only thing that turns "I pasted a token" into "the token works", so what
 * matters is that it reaches the provider with the right credential and that it does not blame the
 * credential for a fault the provider had.
 */

function manifest(overrides: { readonly healthCheckOperationId?: string } = {}): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "2.3.1",
      description: "Do acme things.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [{ id: "api_token", label: "API token", kind: "api_key", required: true }],
      configurationFields: [{ id: "site", label: "Site host", type: "url", required: true }],
      allowedOriginHosts: ["*.acme.test"],
      steps: [
        {
          id: "token",
          title: "Paste an API token",
          type: "fields",
          fields: [
            {
              id: "token",
              label: "API token",
              input: "password",
              target: { type: "credential", slot: "api_token" },
            },
          ],
        },
      ],
      healthCheckOperationId:
        "healthCheckOperationId" in overrides ? overrides.healthCheckOperationId : "whoami",
    },
    operations: [
      {
        id: "whoami",
        name: "acme_whoami",
        description: "Report who this token belongs to.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "api_token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://{site}",
          path: "/api/v1/me",
        },
        response: { maxBytes: 4096, schema: { type: "object" } },
      },
    ],
  } as OimManifest;
}

function connection(): PersistedConnection {
  return {
    id: "conn-1",
    businessId: "business-1",
    integration: { id: "acme", majorVersion: 2 },
    label: "Acme",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: { site: "tenant.acme.test" },
    agentVisibleConfiguration: [],
    secretBindings: { api_token: "secret://oim-acme-abc" },
    health: { status: "unknown", checkedAt: "2025-01-01T00:00:00.000Z" },
    expiresAt: null,
  } as unknown as PersistedConnection;
}

const secrets = { get: async () => "tok-123" } as unknown as SecretsService;

describe("runHealthCheck", () => {
  it("calls the nominated operation with the Connection's credential and host", async () => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const status = await runHealthCheck(manifest(), connection(), {
      secrets,
      http: {
        async send(request) {
          sent.push({ url: request.url, headers: { ...request.headers } });
          return { status: 200, headers: {}, body: { id: "u_1" } };
        },
      },
    });

    expect(status).toBe("healthy");
    expect(sent[0]?.url).toBe("https://tenant.acme.test/api/v1/me");
    expect(sent[0]?.headers.Authorization).toBe("Bearer tok-123");
  });

  it("calls a two-slot health check with both Connection credentials", async () => {
    const twoSlotManifest = manifest();
    const operation = twoSlotManifest.operations[0];
    if (operation === undefined) throw new Error("fixture");
    operation.secondaryCredential = {
      slot: "token",
      injection: { in: "query", name: "token", format: "{token}" },
    };
    const twoSlotConnection = connection();
    twoSlotConnection.secretBindings = {
      api_token: "secret://oim-acme-abc",
      token: "secret://oim-acme-token",
    };
    const sent: { url: string }[] = [];

    await expect(
      runHealthCheck(twoSlotManifest, twoSlotConnection, {
        secrets: {
          get: async (key: string) => (key === "oim-acme-token" ? "token-456" : "tok-123"),
        } as unknown as SecretsService,
        http: {
          async send(request) {
            sent.push({ url: request.url });
            return { status: 200, headers: {}, body: { id: "u_1" } };
          },
        },
      })
    ).resolves.toBe("healthy");

    expect(sent[0]?.url).toBe("https://tenant.acme.test/api/v1/me?token=token-456");
  });

  it("runs a GraphQL health check through its fixed companion document", async () => {
    const graphqlManifest = manifest();
    const operation = graphqlManifest.operations[0];
    if (operation === undefined) throw new Error("fixture");
    const document = "query Viewer { viewer { id } }";
    graphqlManifest.files = [
      { path: "operations/viewer.graphql", role: "graphql", sha256: "0".repeat(64) },
    ];
    operation.source = {
      type: "graphql",
      url: "https://api.acme.test/graphql",
      operation: "Viewer",
      documentFile: "operations/viewer.graphql",
    };
    const sent: Array<{ body?: unknown; headers: Record<string, string> }> = [];

    await expect(
      runHealthCheck(graphqlManifest, connection(), {
        secrets,
        graphqlDocuments: { "operations/viewer.graphql": document },
        http: {
          async send(request) {
            sent.push({ body: request.body, headers: { ...request.headers } });
            return { status: 200, headers: {}, body: { data: { viewer: { id: "u_1" } } } };
          },
        },
      })
    ).resolves.toBe("healthy");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      operationName: "Viewer",
      query: document,
      variables: {},
    });
    expect(sent[0]?.headers.accept).toBe("application/json");
    expect(sent[0]?.headers.Authorization).toBeTruthy();
  });

  it("reports action_required only when the provider refuses the credential", async () => {
    const status = await runHealthCheck(manifest(), connection(), {
      secrets,
      http: {
        async send() {
          return { status: 401, headers: {}, body: { error: "bad token" } };
        },
      },
    });

    expect(status).toBe("action_required");
  });

  it("reports unknown for a provider fault, so nobody rotates a key that was never wrong", async () => {
    const status = await runHealthCheck(manifest(), connection(), {
      secrets,
      http: {
        async send() {
          return { status: 503, headers: {}, body: { error: "upstream down" } };
        },
      },
    });

    expect(status).toBe("unknown");
  });

  it("refuses rather than guessing when the package nominated no health check", async () => {
    await expect(
      runHealthCheck(manifest({ healthCheckOperationId: undefined }), connection(), {
        secrets,
        http: {
          async send() {
            throw new Error("must not be called");
          },
        },
      })
    ).rejects.toBeInstanceOf(OimConnectError);
  });
});
