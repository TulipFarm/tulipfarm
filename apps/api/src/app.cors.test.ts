import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";

// The SPA (origin :4000) talks to the API (:4010) cross-origin, so the CORS preflight must allow the
// write verbs and custom headers the client sends — else PUT/DELETE are blocked before they're sent.
describe("CORS preflight", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({});
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows PUT/DELETE and the CSRF + If-Match headers for the SPA origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/secrets/azure-openai-api-key",
      headers: {
        origin: "http://localhost:4000",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "x-csrf-token,if-match,content-type",
      },
    });
    const allowMethods = String(res.headers["access-control-allow-methods"] ?? "");
    expect(allowMethods).toContain("PUT");
    expect(allowMethods).toContain("DELETE");
    const allowHeaders = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowHeaders).toContain("x-csrf-token");
    expect(allowHeaders).toContain("if-match");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
