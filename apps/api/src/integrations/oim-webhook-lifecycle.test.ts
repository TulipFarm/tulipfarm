import { createHmac } from "node:crypto";
import type { OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerOimIngressRoutes } from "./oim-ingress-routes";
import { OimWebhookLifecycle, OimWebhookLifecycleError } from "./oim-webhook-lifecycle";

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      description: "Acme",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0", events: "1.0" },
    auth: {
      credentialSlots: [
        { id: "api_token", label: "API token", kind: "api_key" },
        { id: "webhook_secret", label: "Webhook secret", kind: "webhook_secret" },
      ],
      steps: [
        {
          id: "webhook",
          title: "Register webhook",
          type: "webhook",
          operationId: "register_webhook",
          unregisterOperationId: "unregister_webhook",
          subscriptionIdPath: "/id",
          secretSlot: "webhook_secret",
          registration: {
            callbackUrl: { in: "body", pointer: "/callback_url" },
            secret: { in: "body", pointer: "/secret" },
          },
          unregistration: { subscriptionId: { in: "body", pointer: "/subscription_id" } },
        },
      ],
    },
    operations: [
      {
        id: "register_webhook",
        name: "acme_register_webhook",
        description: "Register webhook.",
        effect: "create",
        identityMode: "shared_only",
        credentialSlot: "api_token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: { type: "http", method: "POST", baseUrl: "https://api.acme.test", path: "/hooks" },
        requestSchema: { type: "object" },
        response: { maxBytes: 4096, schema: { type: "object" } },
      },
      {
        id: "unregister_webhook",
        name: "acme_unregister_webhook",
        description: "Remove webhook.",
        effect: "delete",
        identityMode: "shared_only",
        credentialSlot: "api_token",
        credentialInjection: { in: "header", name: "Authorization", format: "Bearer {token}" },
        source: {
          type: "http",
          method: "DELETE",
          baseUrl: "https://api.acme.test",
          path: "/hooks",
        },
        requestSchema: { type: "object" },
        response: { maxBytes: 4096, schema: { type: "object" } },
      },
    ],
    events: {
      path: "/acme",
      verification: {
        scheme: "hmac_sha256",
        secretSlot: "webhook_secret",
        signatureHeader: "x-signature",
        signatureEncoding: "hex",
      },
      deduplication: { kind: "payload_hash" },
      eventTypes: [
        {
          type: "updated",
          selector: { pointer: "/type", equals: "updated" },
          schema: { type: "object" },
        },
      ],
    },
  } as unknown as OimManifest;
}

function connection(
  owner: PersistedConnection["owner"] = { scope: "organization" }
): PersistedConnection {
  return {
    businessId: "business-1",
    id: "connection-1",
    integration: { id: "acme", majorVersion: 1 },
    label: "Acme",
    owner,
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {
      api_token: "secret://api-token",
      webhook_secret: "secret://delivery-secret",
    },
    health: { status: "unknown", checkedAt: null },
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fixture(failUnregister = false) {
  let row = connection();
  const secrets = new Map([
    ["api-token", "provider-token"],
    ["delivery-secret", "first-delivery-secret"],
  ]);
  const requests: { method: string; body: unknown }[] = [];
  const store = {
    async put(_businessId: string, input: PersistedConnection) {
      row = { ...input, businessId: "business-1", createdAt: new Date(), updatedAt: new Date() };
    },
    async updateHealth(_businessId: string, _id: string, health: PersistedConnection["health"]) {
      row = { ...row, health };
      return true;
    },
    async listActiveWebhookRegistrations() {
      return [row];
    },
  } as unknown as ConnectionStore;
  const lifecycle = new OimWebhookLifecycle({
    connections: store,
    secrets: {
      get: async (key: string) => {
        const value = secrets.get(key);
        if (value === undefined) throw new Error(`missing ${key}`);
        return value;
      },
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    } as unknown as SecretsService,
    http: {
      async send(request) {
        requests.push({ method: request.method, body: request.body });
        if (request.method === "DELETE" && failUnregister) {
          return { status: 500, headers: {}, body: {} };
        }
        return {
          status: 200,
          headers: {},
          body: request.method === "POST" ? { id: `subscription-${requests.length}` } : {},
        };
      },
    },
    manifestFor: () => ({ slug: "acme", manifest: manifest() }),
  });
  return {
    lifecycle,
    requests,
    get row() {
      return row;
    },
    secrets,
  };
}

describe("OIM webhook lifecycle", () => {
  it("unregisters the provider subscription before a Connection is revoked", async () => {
    const test = fixture();
    await test.lifecycle.register(manifest(), test.row, "https://api.one.test");
    await test.lifecycle.revoke(manifest(), test.row);

    expect(test.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "DELETE",
          body: { subscription_id: "subscription-1" },
        }),
      ])
    );
  });

  it("marks the Connection action-required when provider unregistration fails", async () => {
    const test = fixture(true);
    await test.lifecycle.register(manifest(), test.row, "https://api.one.test");

    await expect(test.lifecycle.revoke(manifest(), test.row)).rejects.toBeInstanceOf(
      OimWebhookLifecycleError
    );
    expect(test.row.status).toBe("active");
    expect(test.row.health.status).toBe("action_required");
  });

  it("re-registers on a new public API origin and rejects deliveries signed by its old secret", async () => {
    const test = fixture();
    await test.lifecycle.register(manifest(), test.row, "https://api.one.test");
    const oldSecret = test.secrets.get("delivery-secret");
    await test.lifecycle.reconcile("https://api.two.test");

    expect(test.row.webhookRegistration?.ingressUrl).toBe(
      "https://api.two.test/api/v1/hooks/oim/acme?connectionId=connection-1"
    );
    expect(test.requests.filter((request) => request.method === "POST")).toHaveLength(2);

    const app = Fastify();
    await registerOimIngressRoutes(app, {
      resolve: async () => ({ businessId: "business-1", manifest: manifest() }),
      binding: async () => ({
        connectionId: test.row.id,
        secretRef: test.row.secretBindings.webhook_secret as string,
      }),
      readSecret: async (ref) => test.secrets.get(ref.replace(/^secret:\/\//, "")) as string,
      encryptPayload: async () => "encrypted",
      inbox: {
        record: async (_businessId, input) =>
          ({
            accepted: true,
            delivery: { ...input, state: "accepted" },
          }) as never,
      } as Parameters<typeof registerOimIngressRoutes>[1]["inbox"],
    });
    const raw = '{"type":"updated"}';
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/oim/acme",
      headers: {
        "content-type": "application/json",
        "x-signature": createHmac("sha256", oldSecret as string)
          .update(raw)
          .digest("hex"),
      },
      payload: raw,
    });
    await app.close();

    expect(response.statusCode).toBe(401);
  });

  it("registers Team webhooks with a Connection-specific ingress URL", async () => {
    const test = fixture();
    const teamConnection = connection({
      scope: "team",
      teamId: "00000000-0000-4000-8000-000000000004",
    });

    await test.lifecycle.register(manifest(), teamConnection, "https://api.one.test");

    expect(test.row.webhookRegistration?.ingressUrl).toBe(
      "https://api.one.test/api/v1/hooks/oim/acme?connectionId=connection-1"
    );
    expect(test.requests[0]).toMatchObject({
      method: "POST",
      body: {
        callback_url: "https://api.one.test/api/v1/hooks/oim/acme?connectionId=connection-1",
      },
    });
  });

  it("registers personal webhooks with a Connection-specific ingress URL", async () => {
    const test = fixture();
    const personalConnection = connection({
      scope: "personal",
      principalKind: "user",
      principalId: "user-1",
    });

    await test.lifecycle.register(manifest(), personalConnection, "https://api.one.test");

    expect(test.row.webhookRegistration?.ingressUrl).toBe(
      "https://api.one.test/api/v1/hooks/oim/acme?connectionId=connection-1"
    );
    expect(test.requests[0]).toMatchObject({
      method: "POST",
      body: {
        callback_url: "https://api.one.test/api/v1/hooks/oim/acme?connectionId=connection-1",
      },
    });
  });
});
