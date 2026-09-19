import { defineConfig } from "@playwright/test";

const baseURL = process.env.WWW_PREVIEW_URL ?? "http://127.0.0.1:5100";

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: process.env.WWW_PREVIEW_URL
    ? undefined
    : {
        command: "pnpm preview",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { WRANGLER_SEND_METRICS: "false" },
      },
});
