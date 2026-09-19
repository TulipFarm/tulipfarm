import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  externalPptx,
  externalXlsx,
} from "../../../../packages/files/src/office-fixture.test-support";
import type { DocxPreviewReply } from "../../app/components/files/docx-preview-client";
import { syntheticDocx } from "./docx-fixture";

const clientDir = fileURLToPath(new URL("../../build/client/", import.meta.url));
let server: Server;
let origin: string;
let workerPath: string;
let csp: string;

test.beforeAll(async () => {
  const assets = readdirSync(resolve(clientDir, "assets"));
  const worker = assets.find((name) => /^docx-preview\.worker-.*\.js$/.test(name));
  if (!worker) throw new Error("Build the web app before running the Word browser checks.");
  expect(assets.some((name) => name.endsWith(".wasm"))).toBe(true);
  workerPath = `/assets/${worker}`;
  csp = readFileSync(resolve(clientDir, ".csp-header.txt"), "utf8").trim();
  expect(readFileSync(resolve(clientDir, "licenses/anydoc.txt"), "utf8")).toContain(
    "Copyright (c) 2026 Sideguide Technologies Inc."
  );
  server = createServer((request, response) => {
    response.setHeader("Content-Security-Policy", csp);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><html><head><title>Local document preview</title></head><body></body></html>"
      );
      return;
    }
    const path = resolve(clientDir, `.${pathname}`);
    if (!path.startsWith(`${resolve(clientDir)}/`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".wasm": "application/wasm",
      };
      response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
      response.end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing browser-test port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the shipped worker opens a real Word document using same-origin WASM under production CSP", async ({
  page,
}) => {
  const requests: string[] = [];
  const violations: string[] = [];
  const errors: string[] = [];
  await page.exposeFunction("recordCspViolation", (value: string) => violations.push(value));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const target = window as Window & { recordCspViolation?: (value: string) => void };
      target.recordCspViolation?.(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  await page.context().route("**/*", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (!url.startsWith(`${origin}/`)) await route.abort();
    else await route.continue();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(origin);
  expect(response?.headers()["content-security-policy"]).toBe(csp);
  expect(csp).toMatch(/script-src[^;]*'sha256-/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(requests.some((url) => /\.(wasm|js)$/.test(url))).toBe(false);

  const bytes = syntheticDocx();
  const reply = await page.evaluate(
    async ({ workerPath, source }) => {
      const worker = new Worker(workerPath, { type: "module" });
      try {
        return await new Promise<DocxPreviewReply>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = () => reject(new Error("Built Word worker failed"));
          worker.postMessage({ bytes: new Uint8Array(source) });
        });
      } finally {
        worker.terminate();
      }
    },
    { workerPath, source: Array.from(bytes) }
  );
  expect(reply.kind).toBe("ready");
  expect(JSON.stringify(reply)).toContain("Synthetic browser fact");
  expect(JSON.stringify(reply)).toContain("Nested supporting task");
  expect(JSON.stringify(reply)).toContain("Synthetic footnote evidence");
  expect(JSON.stringify(reply)).not.toContain("example.invalid");
  expect(requests.some((url) => url.endsWith(".wasm"))).toBe(true);
  expect(requests.every((url) => url.startsWith(`${origin}/`))).toBe(true);
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("malformed Word bytes produce a typed refusal rather than an empty document", async ({
  page,
}) => {
  await page.goto(origin);
  const reply = await page.evaluate(async (path) => {
    const worker = new Worker(path, { type: "module" });
    try {
      return await new Promise<DocxPreviewReply>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = () => reject(new Error("Built Word worker failed"));
        worker.postMessage({ bytes: new Uint8Array([80, 75, 3, 4]) });
      });
    } finally {
      worker.terminate();
    }
  }, workerPath);
  expect(reply).toEqual({ kind: "failed", code: "malformed" });
});

test("real conversion discloses both the block and table-row preview caps", async ({ page }) => {
  await page.goto(origin);
  for (const options of [{ paragraphs: 410 }, { rows: 201 }]) {
    const reply = await page.evaluate(
      async ({ path, source }) => {
        const worker = new Worker(path, { type: "module" });
        try {
          return await new Promise<DocxPreviewReply>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = () => reject(new Error("Built Word worker failed"));
            worker.postMessage({ bytes: new Uint8Array(source) });
          });
        } finally {
          worker.terminate();
        }
      },
      { path: workerPath, source: Array.from(syntheticDocx(options)) }
    );
    expect(reply.kind).toBe("ready");
    if (reply.kind !== "ready") throw new Error(`Conversion refused: ${reply.code}`);
    expect(reply.preview.truncated).toBe(true);
    expect(reply.preview.blocks.length).toBeLessThanOrEqual(400);
    if ("rows" in options) {
      const table = reply.preview.blocks.find((block) => block.kind === "table");
      expect(table?.rows).toHaveLength(200);
      expect(JSON.stringify(reply)).not.toContain("Final table fact");
    } else {
      expect(JSON.stringify(reply)).not.toContain("Beyond preview fact");
    }
  }
});

for (const format of ["xlsx", "pptx"] as const) {
  test(`the shipped ${format} worker uses pinned local semantics and never fetches source assets`, async ({
    page,
  }) => {
    const requests: string[] = [];
    const errors: string[] = [];
    await page.context().route("**/*", async (route) => {
      const url = route.request().url();
      requests.push(url);
      if (!url.startsWith(`${origin}/`)) await route.abort();
      else await route.continue();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const bytes = format === "xlsx" ? externalXlsx() : externalPptx();
    const reply = await page.evaluate(
      async ({ path, source, format }) => {
        const worker = new Worker(path, { type: "module" });
        try {
          return await new Promise<DocxPreviewReply>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = () => reject(new Error("Built Office worker failed"));
            worker.postMessage({ bytes: new Uint8Array(source), format });
          });
        } finally {
          worker.terminate();
        }
      },
      { path: workerPath, source: Array.from(bytes), format }
    );
    expect(reply.kind).toBe("ready");
    if (reply.kind !== "ready") throw new Error(reply.code);
    const text = JSON.stringify(reply.preview.blocks);
    expect(text).not.toContain("example.invalid");
    if (format === "xlsx") {
      expect(reply.preview.truncated).toBe(true);
      expect(text).not.toMatch(/731 tulips|Hidden (sheet|column|row) secret/);
      for (const value of [
        "Visible inventory",
        "Visible summary",
        "2024-01-01",
        "12.50%",
        "$1,234.50",
        "42",
      ]) {
        expect(text).toContain(value);
      }
      const grid = reply.preview.blocks.find((block) => block.kind === "table");
      expect(grid?.rows).toHaveLength(200);
      expect(grid?.rows[6]).toEqual(["", "Sparse associated value"]);
      expect(grid?.spans).toContainEqual({ row: 5, column: 0, rowSpan: 1, colSpan: 2 });
    } else {
      expect(text).toContain("Speaker notes");
      expect(text).toContain("47 days");
      expect(text).toContain("Pune");
      expect(reply.preview.blocks.some((block) => block.kind === "slide")).toBe(false);
    }
    expect(requests.some((url) => url.endsWith(".wasm"))).toBe(true);
    expect(requests.every((url) => url.startsWith(`${origin}/`))).toBe(true);
    expect(errors).toEqual([]);
  });
}
