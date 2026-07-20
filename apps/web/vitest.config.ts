import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const appVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  .version as string;

// NOTE: deliberately does NOT load the Remix Vite plugin — it injects a server build that
// breaks component tests. Use @vitejs/plugin-react and re-declare the ~ alias here.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "~": new URL("./app", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
