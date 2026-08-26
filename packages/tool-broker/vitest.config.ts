import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boots a WASM Postgres instance before the effect-store integration test. That boot is
    // ~0.5s on an idle machine, but the package-wide coverage job runs ten packages at once on a
    // four-core runner, so it is CPU-starved rather than slow: an observed run exceeded 30s. The
    // ceiling exists to catch a genuine hang, so it sits far above the contended cost rather than
    // just above the idle one.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
