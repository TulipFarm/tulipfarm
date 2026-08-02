#!/usr/bin/env node
/*
 * Compatibility launcher for the production browser suite.
 *
 * Keep this positional CLI because installer-smoke.sh is also useful locally. The suite itself is
 * Playwright Test so each journey gets isolated fixtures, traces, and an actionable report.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const baseUrl = process.argv[2];
const requireInsecure = process.argv.includes("--require-insecure");
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

if (!baseUrl || process.argv.some((arg, index) => index > 2 && arg !== "--require-insecure")) {
  console.error("usage: browser-smoke.mjs <base-url> [--require-insecure]");
  process.exit(2);
}

const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "--config", `${repoRoot}/scripts/test/playwright.config.ts`],
  {
    stdio: "inherit",
    cwd: repoRoot,
    env: {
      ...process.env,
      BROWSER_SMOKE_BASE_URL: baseUrl,
      BROWSER_SMOKE_REQUIRE_INSECURE: requireInsecure ? "1" : "0",
    },
  }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
