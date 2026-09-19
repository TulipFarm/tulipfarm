import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  envDir: false,
  root: new URL("../", import.meta.url).pathname,
  cacheDir: "node_modules/.vite-browser-imports",
  resolve: { alias: { "~": new URL("../app", import.meta.url).pathname } },
  server: { host: "127.0.0.1", port: 0, watch: null },
  plugins: [
    {
      name: "browser-import-test-page",
      configureServer(server) {
        server.middlewares.use("/__browser_imports__", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end("<!doctype html><title>Browser import regression</title>");
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}__browser_imports__`);
  const failures = [];
  for (const module of ["schema", "packs"]) {
    try {
      const result = await page.evaluate(async (module) => {
        const imported = await import(`/app/lib/${module}.ts`);
        if (module === "schema") {
          return {
            valid: imported.formatIsoDate("2024-02-29"),
            invalid: imported.formatIsoDate("2025-02-29"),
          };
        }
        return {
          categories: imported.PACK_CATEGORIES,
          accepted: imported.packChatLaunchError("Plan this Pack"),
          rejected: imported.packChatLaunchError("x".repeat(128 * 1024 + 1)) !== null,
        };
      }, module);
      if (module === "schema") {
        assert.notEqual(result.valid, "2024-02-29");
        assert.equal(result.invalid, "2025-02-29");
      } else {
        assert.ok(result.categories.includes("Engineering"));
        assert.equal(result.accepted, null);
        assert.equal(result.rejected, true);
      }
      console.log(`PASS: /app/lib/${module}.ts imports and runs in Vite/Chromium`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL: /app/lib/${module}.ts`, error.message);
    }
  }
  assert.equal(failures.length, 0, "Browser imports must not load Node-only modules");
} finally {
  await browser?.close();
  await server.close();
}
