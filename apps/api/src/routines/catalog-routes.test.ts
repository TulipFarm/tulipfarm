import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineCatalog } from "./catalog";
import { registerRoutineCatalogRoutes } from "./catalog-routes";

describe("Routine catalogue routes", () => {
  let app: FastifyInstance;
  const catalog = {
    list: vi.fn<RoutineCatalog["list"]>(async () => [
      {
        id: "routine-1",
        slug: "daily-wait",
        displayName: "Daily wait",
        authoredVersion: 2,
        triggers: [{ slug: "daily-wait-manual", type: "manual", summary: "manual" }],
      },
    ]),
  };

  beforeEach(async () => {
    app = Fastify();
    registerRoutineCatalogRoutes(app, catalog, async () => undefined);
    await app.ready();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it("lists the canonical published catalogue", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/routines" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: "routine-1",
          slug: "daily-wait",
          displayName: "Daily wait",
          authoredVersion: 2,
          triggers: [{ slug: "daily-wait-manual", type: "manual", summary: "manual" }],
        },
      ],
    });
  });

  it("fails visibly when the active catalogue cannot be verified", async () => {
    catalog.list.mockRejectedValueOnce(new Error("signature invalid"));

    const response = await app.inject({ method: "GET", url: "/api/v1/routines" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Active Routine catalogue is unavailable." });
  });
});
