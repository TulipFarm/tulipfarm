import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**"],
    // Most suites boot a PGlite (WASM Postgres) + run all migrations per test file; with
    // one worker per core the 5s default flakes under full-suite load. Generous ceilings
    // keep slow-machine/CI runs honest — genuinely hung tests still fail.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
