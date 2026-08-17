import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `store.pg.test.ts` and `tool.test.ts` boot a PGlite (WASM Postgres) and apply every
    // `MEMORY_DOCUMENT_STORAGE_STATEMENTS` DDL in `beforeAll`. Under the package-wide coverage
    // job that startup exceeds Vitest's 10s default while workers compete for CPU. Match
    // storage's bounded CI ceiling so slow initialization is not treated as a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
