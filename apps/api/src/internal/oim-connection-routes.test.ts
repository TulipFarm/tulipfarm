import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerInternalOimConnectionRoutes } from "./oim-connection-routes";

describe("registerInternalOimConnectionRoutes", () => {
  it("runs the due refresh sweep for an authenticated service principal", async () => {
    const refreshDue = vi.fn(async () => ({ examined: 2, refreshed: 1, failed: 1 }));
    const app = Fastify();
    registerInternalOimConnectionRoutes(app, { refreshDue }, async (request) => {
      request.principal = {
        id: "worker",
        kind: "service",
        businessId: "business-1",
        credential: "client_secret",
        authMethods: [],
        authenticatedAt: new Date(),
        clientId: "worker",
      };
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/oim/connections/refresh-due",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ examined: 2, refreshed: 1, failed: 1 });
    expect(refreshDue).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not run when service authentication refuses the request", async () => {
    const refreshDue = vi.fn(async () => ({ examined: 0, refreshed: 0, failed: 0 }));
    const app = Fastify();
    registerInternalOimConnectionRoutes(app, { refreshDue }, async (_request, reply) => {
      await reply.code(401).send({ error: "unauthorized" });
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/oim/connections/refresh-due",
    });

    expect(response.statusCode).toBe(401);
    expect(refreshDue).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses an authenticated user principal", async () => {
    const refreshDue = vi.fn(async () => ({ examined: 0, refreshed: 0, failed: 0 }));
    const app = Fastify();
    registerInternalOimConnectionRoutes(app, { refreshDue }, async (request) => {
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
      method: "POST",
      url: "/api/v1/internal/oim/connections/refresh-due",
    });

    expect(response.statusCode).toBe(403);
    expect(refreshDue).not.toHaveBeenCalled();
    await app.close();
  });
});
