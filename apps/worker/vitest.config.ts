import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `pnpm build` emits compiled copies of these tests into dist/; running those CJS files under
    // vitest fails. Only the TypeScript sources are the suite.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**"],
  },
});
