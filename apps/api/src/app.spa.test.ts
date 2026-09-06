import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

// The single `app` image serves the built SPA at `/` and the
// API at `/api/v1/*` from one process. Serving is opt-in via WEB_DIST (set in the
// Dockerfile runtime stage; unset in native `pnpm dev`, where Vite serves the SPA).

const INDEX_MARKER = "<!-- tulipfarm-spa-test -->";
const ASSET_BODY = `export const ok = ${"1".repeat(4096)};\n`;

describe("SPA static serving (WEB_DIST set)", () => {
  let dir: string;
  let app: FastifyInstance;
  const prev = process.env.WEB_DIST;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tf-webdist-"));
    writeFileSync(join(dir, "index.html"), `<!doctype html><html>${INDEX_MARKER}</html>`);
    writeFileSync(
      join(dir, ".csp-header.txt"),
      "default-src 'self'; script-src 'self' 'unsafe-eval' 'sha256-test'; style-src 'self'"
    );
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "export const ok = 1;\n");
    writeFileSync(join(dir, "assets", "big.js"), ASSET_BODY);
    writeFileSync(join(dir, "assets", "big.js.br"), brotliCompressSync(Buffer.from(ASSET_BODY)));
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

  it("content-hashed assets are cached forever; index.html always revalidates", async () => {
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    for (const url of ["/", "/resources/abc/edit"]) {
      const doc = await app.inject({ method: "GET", url });
      expect(doc.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("serves the build's precompressed sibling when the client accepts brotli", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/assets/big.js",
      headers: { "accept-encoding": "br" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(Number(res.headers["content-length"])).toBeLessThan(ASSET_BODY.length);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("falls back to the plain asset when the client cannot decode brotli", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/assets/big.js",
      headers: { "accept-encoding": "identity" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toBe(ASSET_BODY);
  });

  it("compresses dynamic JSON responses", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  /*
   * The header alone proves nothing: a route whose handler resolves `undefined` after calling
   * `reply.send()` ships `content-encoding: gzip` with an empty body, which every browser reports
   * as "Unexpected end of JSON input" while curl (which does not ask for gzip by default) looks
   * fine. Decompressing and comparing against the uncompressed response is the only assertion that
   * catches it.
   */
  it("a compressed response carries the same body as the uncompressed one", async () => {
    const plain = await app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { "accept-encoding": "identity" },
    });
    const gzipped = await app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzipped.headers["content-encoding"]).toBe("gzip");
    expect(gzipped.rawPayload.length).toBeGreaterThan(0);
    expect(gunzipSync(gzipped.rawPayload).toString("utf8")).toBe(plain.body);
  });

  it("the SPA document gets a self-allowing CSP (not helmet's default-src 'none')", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("default-src 'none'");
  });

  it("fails closed when the production CSP artifact is missing", async () => {
    const invalidDir = mkdtempSync(join(tmpdir(), "tf-webdist-invalid-"));
    writeFileSync(join(invalidDir, "index.html"), "<!doctype html><html></html>");
    const previous = process.env.WEB_DIST;
    process.env.WEB_DIST = invalidDir;
    await expect(buildApp()).rejects.toThrow("missing or invalid");
    if (previous === undefined) delete process.env.WEB_DIST;
    else process.env.WEB_DIST = previous;
    rmSync(invalidDir, { recursive: true, force: true });
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
