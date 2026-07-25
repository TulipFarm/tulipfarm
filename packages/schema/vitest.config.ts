import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The definition-registry tests AJV-compile every authored kind's schema, which takes well
    // under a second locally but is an order of magnitude slower under the package-wide coverage
    // job while workers compete for CPU. Match the ceiling storage and tool-broker already use so
    // slow compilation is not treated as a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
