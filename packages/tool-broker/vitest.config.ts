import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boots a WASM Postgres instance before the effect-store integration test. Under the
    // package-wide coverage job, startup can exceed Vitest's 10s default while workers compete
    // for CPU. Match storage's bounded CI ceiling so slow initialization is not treated as a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
