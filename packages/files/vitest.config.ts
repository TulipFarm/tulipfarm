import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Image bounding decodes, resizes and re-encodes real rasters through jimp. That work is the
    // thing under test, so it cannot be stubbed away, and under the package-wide coverage job on a
    // two-core runner a single downscale exceeds Vitest's default. Match the ceiling the other
    // real-work packages use so slow codec work is not reported as a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
