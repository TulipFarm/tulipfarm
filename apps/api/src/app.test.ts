import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";

describe("Fastify app", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /health returns 200 with status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /livez returns 200 without touching any dependency", async () => {
    const res = await app.inject({ method: "GET", url: "/livez" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 when the datastore answers", async () => {
    const ready = await buildApp({ readiness: { query: async () => ({ rows: [] }) } });
    try {
      const res = await ready.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    } finally {
      await ready.close();
    }
  });

  it("GET /readyz returns 503 when the datastore is unreachable", async () => {
    const ready = await buildApp({
      readiness: {
        query: async () => {
          throw new Error("connection refused");
        },
      },
    });
    try {
      const res = await ready.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.json().status).not.toBe("ok");
      // /livez must stay green — a dead datastore is not a reason to kill the process.
      const live = await ready.inject({ method: "GET", url: "/livez" });
      expect(live.statusCode).toBe(200);
    } finally {
      await ready.close();
    }
  });

  it("allows CORS for configured origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:4000" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:4000");
  });

  it("does not reflect unknown origins in CORS header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://evil.com" },
    });
    expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.com");
  });

  it("includes content-security-policy header from helmet", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});
