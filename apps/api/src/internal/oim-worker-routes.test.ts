import type {
  StagedWebhookSecret,
  WebhookRegistrationReconciliation,
} from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  type InternalOimWorkerRouteDeps,
  registerInternalOimWorkerRoutes,
} from "./oim-worker-routes";

const manifest: OimManifest = {
  oimVersion: "1.0",
  kind: "Integration",
  metadata: {
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    description: "Acme Integration.",
    license: "Apache-2.0",
  },
  profiles: { core: "1.0" },
  operations: [],
};

function deps(): InternalOimWorkerRouteDeps {
  const stagedSecret: StagedWebhookSecret = {
    ref: "secret://staged",
    async use<T>(callback: (secret: string) => Promise<T> | T): Promise<T> {
      return callback("opaque-use-token");
    },
  };
  const reconciliation: WebhookRegistrationReconciliation = {
    kind: "unknown",
    reason: "provider absence is not proven",
  };
  return {
    listPollingRegistrations: vi.fn(async () => []),
    resolveConnectionManifest: vi.fn(async () => ({ integrationKey: "acme", manifest })),
    resolveIntegrationManifest: vi.fn(async () => ({ integrationKey: "acme", manifest })),
    resolveRegistrationManifest: vi.fn(async () => ({ integrationKey: "acme", manifest })),
    executePollingOperation: vi.fn(async () => ({
      response: { items: [] },
      authenticatedEvidenceDigest: "a".repeat(64),
      verifiedIdentity: { externalTenantId: "tenant-1", externalAccountId: "account-1" },
    })),
    executeKnowledgeOperation: vi.fn(async () => ({ body: { items: [] } })),
    stageWebhookCredential: vi.fn(async () => stagedSecret),
    revokeWebhookCredential: vi.fn(async () => {}),
    revokeWebhookCredentialAttempt: vi.fn(async () => {}),
    registerWebhook: vi.fn(async () => ({
      subscriptionId: "subscription-1",
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        proofDigest: "b".repeat(64),
        verifiedAt: "2026-09-12T00:00:00.000Z",
        verifiedBy: "test",
      },
    })),
    reconcileWebhook: vi.fn(async () => reconciliation),
    unregisterWebhook: vi.fn(async () => {}),
    encryptPayload: vi.fn(async () => "encrypted"),
    decryptPayload: vi.fn(async () => Buffer.from("plain")),
    runHook: vi.fn(async () => ({ normalized: true })),
    listKnowledgeRegistrations: vi.fn(async () => []),
    resolveKnowledgeIdentities: vi.fn(async () => ({ principals: [], incomplete: false })),
  };
}

async function serviceApp(routeDeps: InternalOimWorkerRouteDeps) {
  const app = Fastify();
  registerInternalOimWorkerRoutes(app, routeDeps, async (request) => {
    request.principal = {
      id: "integration-worker",
      kind: "service",
      businessId: "business-1",
      credential: "client_secret",
      authMethods: [],
      authenticatedAt: new Date(),
      clientId: "integration-worker",
    };
  });
  return app;
}

describe("registerInternalOimWorkerRoutes", () => {
  it("advertises the complete versioned Worker contract only to service principals", async () => {
    const routeDeps = deps();
    const app = await serviceApp(routeDeps);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/internal/oim/worker-contract",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: 1,
      capabilities: [
        "connection-bound-operations",
        "exact-manifest-resolution",
        "hooks",
        "knowledge-registrations",
        "payload-crypto",
        "verified-provider-identity",
        "webhook-registration",
      ],
    });
    await app.close();
  });

  it("returns an immutable manifest with its canonical digest and preserves not-found", async () => {
    const routeDeps = deps();
    const app = await serviceApp(routeDeps);

    const found = await app.inject({
      method: "POST",
      url: "/api/v1/internal/oim/manifests/connection",
      payload: {
        businessId: "business-1",
        connectionId: "connection-1",
        integrationId: "acme",
        integrationMajorVersion: 1,
      },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ integrationKey: "acme", manifest });

    vi.mocked(routeDeps.resolveConnectionManifest).mockResolvedValueOnce(null);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/internal/oim/manifests/connection",
      payload: {
        businessId: "business-1",
        connectionId: "connection-1",
        integrationId: "acme",
        integrationMajorVersion: 1,
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "oim_manifest_not_found" });
    await app.close();
  });

  it("never returns staged webhook plaintext to the Worker", async () => {
    const routeDeps = deps();
    const app = await serviceApp(routeDeps);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/oim/webhook-credentials/stage",
      payload: {
        attemptId: "attempt-1",
        integrationId: "acme",
        credentialSlot: "webhook_secret",
        existingRef: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      stagedCredentialRef: "secret://staged",
      useToken: "opaque-use-token",
    });
    await app.close();
  });

  it("refuses every route to an authenticated non-service principal", async () => {
    const routeDeps = deps();
    const app = Fastify();
    registerInternalOimWorkerRoutes(app, routeDeps, async (request) => {
      request.principal = {
        id: "user-1",
        kind: "user",
        businessId: "business-1",
        credential: "session",
        authMethods: ["password"],
        authenticatedAt: new Date(),
        userId: "user-1",
        role: "admin",
      };
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/internal/oim/knowledge-registrations",
    });

    expect(response.statusCode).toBe(403);
    expect(routeDeps.listKnowledgeRegistrations).not.toHaveBeenCalled();
    await app.close();
  });
});
