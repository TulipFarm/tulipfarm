import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The `*.pg.test.ts` suites boot a PGlite (WASM Postgres) and apply every storage DDL
    // statement in `beforeAll`; with one worker per core that exceeds the 10s default hook
    // timeout on CI. Generous ceilings keep loaded runs honest — hung tests still fail.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
