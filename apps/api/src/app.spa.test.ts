import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

// AC-010 / ARCH-V1-006: the single `app` image serves the built SPA at `/` and the
// API at `/api/v1/*` from one process. Serving is opt-in via WEB_DIST (set in the
// Dockerfile runtime stage; unset in native `pnpm dev`, where Vite serves the SPA).

const INDEX_MARKER = "<!-- tulipfarm-spa-test -->";

describe("SPA static serving (WEB_DIST set)", () => {
  let dir: string;
  let app: FastifyInstance;
  const prev = process.env.WEB_DIST;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tf-webdist-"));
    writeFileSync(join(dir, "index.html"), `<!doctype html><html>${INDEX_MARKER}</html>`);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "export const ok = 1;\n");
    process.env.WEB_DIST = dir;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    if (prev === undefined) delete process.env.WEB_DIST;
    else process.env.WEB_DIST = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET / serves index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain(INDEX_MARKER);
  });

  it("GET /assets/app.js serves the real asset file", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export const ok");
  });

  it("GET an unknown client route falls back to index.html (SPA deep-link)", async () => {
    const res = await app.inject({ method: "GET", url: "/resources/abc/edit" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain(INDEX_MARKER);
  });

  it("unknown /api route still returns a JSON 404 (fallback must not hijack the API)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).not.toContain(INDEX_MARKER);
  });

  it("GET /health is unaffected", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("the SPA document gets a self-allowing CSP (not helmet's default-src 'none')", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("default-src 'none'");
  });
});

describe("SPA static serving (WEB_DIST unset — dev parity)", () => {
  let app: FastifyInstance;
  const prev = process.env.WEB_DIST;

  beforeAll(async () => {
    delete process.env.WEB_DIST;
    app = await buildApp();
  });

  afterEach(() => {
    /* no-op */
  });

  afterAll(async () => {
    await app.close();
    if (prev !== undefined) process.env.WEB_DIST = prev;
  });

  it("GET / returns 404 (no static layer; Vite serves the SPA in dev)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
  });
});
