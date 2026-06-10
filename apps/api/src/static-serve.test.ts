import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "webdist-"));
  // Mirror the real build output: an inline <script> (theme init / Remix bootstrap) whose
  // execution the CSP must permit, or the served SPA silently fails to hydrate in a browser.
  await fs.writeFile(
    path.join(dir, "index.html"),
    "<!doctype html><title>TulipFarm SPA</title><script>window.__x=1</script>"
  );
  await fs.writeFile(path.join(dir, "app.js"), "console.log('spa')");
  vi.stubEnv("WEB_DIST", dir);
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("static SPA serving (WEB_DIST)", () => {
  it("serves index.html at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("TulipFarm SPA");
  });

  it("serves a static asset", async () => {
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("spa");
  });

  it("falls back to index.html for an unknown client route", async () => {
    const res = await app.inject({ method: "GET", url: "/setup/some/deep/route" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("TulipFarm SPA");
  });

  it("still returns JSON 404 for an unknown /api path", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("keeps /health working", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("serves the SPA for a client path that merely starts with 'api' (not /api/)", async () => {
    const res = await app.inject({ method: "GET", url: "/apidocs-guide" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("TulipFarm SPA");
  });

  it("falls back to index.html for a HEAD request to a client route", async () => {
    const res = await app.inject({ method: "HEAD", url: "/setup" });
    expect(res.statusCode).toBe(200);
  });

  it("sets a SPA-compatible CSP (self origin, allows connect + inline scripts, no UIR)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("upgrade-insecure-requests");
    // The built index.html ships inline scripts (theme init + Remix bootstrap); the policy
    // must allow them or the SPA won't hydrate. Assert script-src permits inline execution.
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("'unsafe-inline'");
  });
});
