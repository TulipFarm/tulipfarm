import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import {
  type OimWebhookManagementService,
  registerOimWebhookManagementRoutes,
} from "./management-routes";
import { registerOimIngressRoutes } from "./routes";

describe("OIM ingress HTTP routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("passes exact callback route identity and raw bytes to the verified receiver", async () => {
    const receive = vi.fn(async () => ({
      kind: "accepted" as const,
      deliveryId: "delivery-1",
      duplicate: false,
    }));
    await registerOimIngressRoutes(app, { receive });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/oim/acme-v2/connection-1",
      headers: {
        "content-type": "application/json",
        "x-signature": "signed",
      },
      payload: '{"type":"ticket_created"}',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        route: { integrationKey: "acme-v2", connectionId: "connection-1" },
        rawBody: Buffer.from('{"type":"ticket_created"}'),
        headers: expect.objectContaining({ "x-signature": "signed" }),
      })
    );
  });

  it("returns one privacy-preserving acknowledgement for unavailable routes", async () => {
    await registerOimIngressRoutes(app, {
      receive: async () => ({ kind: "unavailable", reason: "not_connected" }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/oim/unknown-v9/not-a-connection",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
  });

  it("does not acknowledge unauthenticated delivery evidence", async () => {
    await registerOimIngressRoutes(app, {
      receive: async () => ({ kind: "unverified", reason: "missing_signature" }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/oim/acme-v2/connection-1",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid signature" });
  });

  it("routes protected registration commands through the exact key and Connection", async () => {
    const registration = {
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
      state: "active",
      desiredState: "active" as const,
      callbackUrl: "https://api.example.test/api/v1/hooks/oim/acme-v2/connection-1",
      lastError: null,
    };
    const service: OimWebhookManagementService = {
      register: vi.fn(async () => registration),
      reconcile: vi.fn(async () => registration),
      remove: vi.fn(async () => ({
        ...registration,
        state: "removed",
        desiredState: "removed" as const,
      })),
    };
    registerOimWebhookManagementRoutes(app, {
      service,
      requireAuth: async (request) => {
        request.principal = {
          kind: "user",
          id: "user-1",
          businessId: "business-1",
          credential: "session",
          authMethods: ["password"],
          authenticatedAt: new Date(),
        };
      },
      requireAuthorization: () => async () => {},
      authorizationCheck: async () => true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/acme-v2/connections/connection-1/webhook-registration",
    });

    expect(response.statusCode).toBe(200);
    expect(service.register).toHaveBeenCalledWith("acme-v2", "connection-1", {
      principalId: "user-1",
      mayManageShared: true,
    });
  });
});
