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
