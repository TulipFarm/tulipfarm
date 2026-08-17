import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

/**
 * Pinned so the assertions below do not depend on the developer's `.env.local`: the allowed origin
 * falls back through `CORS_ORIGIN`, `PUBLIC_URL` and `VITE_PORT`, so a checkout running its web app
 * on any port but 4000 would otherwise fail this file.
 */
const ALLOWED_ORIGIN = "http://localhost:4000";

describe("Fastify app", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv("CORS_ORIGIN", ALLOWED_ORIGIN);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
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
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
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
