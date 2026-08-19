import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BROWSER_SMOKE_BASE_URL;
if (!baseURL) throw new Error("BROWSER_SMOKE_BASE_URL is required");
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  testDir: resolve(repoRoot, "scripts/test/browser"),
  outputDir: resolve(repoRoot, "test-results/browser"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: resolve(repoRoot, "playwright-report"), open: "never" }]]
    : [["list"], ["html", { outputFolder: resolve(repoRoot, "playwright-report"), open: "never" }]],
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "bootstrap",
      testMatch: /.*\.setup\.ts/,
      use: { storageState: undefined },
    },
    {
      name: "chromium",
      dependencies: ["bootstrap"],
      testMatch: /.*\.spec\.ts/,
      testIgnore: /\.colleague\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: resolve(repoRoot, "scripts/test/.auth/user.json"),
      },
    },
    {
      name: "firefox",
      dependencies: ["bootstrap"],
      testMatch: /.*\.spec\.ts/,
      testIgnore: /\.colleague\.spec\.ts$/,
      use: {
        ...devices["Desktop Firefox"],
        storageState: resolve(repoRoot, "scripts/test/.auth/user.json"),
      },
    },
    {
      name: "mobile-chromium",
      dependencies: ["bootstrap"],
      testMatch: /.*\.spec\.ts/,
      testIgnore: /\.colleague\.spec\.ts$/,
      use: {
        ...devices["Pixel 5"],
        storageState: resolve(repoRoot, "scripts/test/.auth/user.json"),
      },
    },
    {
      // Selects the second-member identity: any `*.colleague.spec.ts` file runs already signed
      // in as the Business's ordinary (non-admin) colleague, via the session
      // second-member.setup.ts stored. The three projects above explicitly ignore these files so
      // a colleague spec never also runs as the original member.
      name: "colleague",
      dependencies: ["bootstrap"],
      testMatch: /\.colleague\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: resolve(repoRoot, "scripts/test/.auth/colleague.json"),
      },
    },
  ],
});
