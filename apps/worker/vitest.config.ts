import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `pnpm build` emits compiled copies of these tests into dist/; running those CJS files under
    // vitest fails. Only the TypeScript sources are the suite.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["dist/**"],
    // PGlite (real WASM Postgres) boot time spikes under CI's parallel test-file load; the
    // default 5000ms trips intermittently even though the same tests run in ~2s locally.
    testTimeout: 15000,
  },
});
