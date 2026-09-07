import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRoutineOwnerAuthorityRoutes } from "./routine-owner-authority-routes";

describe("Routine owner authority routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("accepts only a Run id and returns the host decision to a service principal", async () => {
    const app = Fastify();
    apps.push(app);
    const checkRoutineOwner = vi.fn(async () => ({
      status: "denied" as const,
      reason: "personal_owner_disabled" as const,
    }));
    registerRoutineOwnerAuthorityRoutes(app, { checkRoutineOwner }, async (request) => {
      request.principal = {
        kind: "service",
        id: "worker",
        businessId: "business-1",
        credential: "client_secret",
        authMethods: ["password"],
        authenticatedAt: new Date("2026-09-07T00:00:00.000Z"),
      };
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/internal/runs/run-1/routine-owner-status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "denied",
      reason: "personal_owner_disabled",
    });
    expect(checkRoutineOwner).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("rejects a non-service principal", async () => {
    const app = Fastify();
    apps.push(app);
    const checkRoutineOwner = vi.fn();
    registerRoutineOwnerAuthorityRoutes(app, { checkRoutineOwner }, async () => {});

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/internal/runs/run-1/routine-owner-status",
    });

    expect(response.statusCode).toBe(403);
    expect(checkRoutineOwner).not.toHaveBeenCalled();
  });

  it("returns a non-success status when owner authority is unavailable", async () => {
    const app = Fastify();
    apps.push(app);
    registerRoutineOwnerAuthorityRoutes(
      app,
      { checkRoutineOwner: async () => ({ status: "unavailable" }) },
      async (request) => {
        request.principal = {
          kind: "service",
          id: "worker",
          businessId: "business-1",
          credential: "client_secret",
          authMethods: ["password"],
          authenticatedAt: new Date("2026-09-07T00:00:00.000Z"),
        };
      }
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/internal/runs/run-1/routine-owner-status",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "routine_owner_unavailable" });
  });
});
