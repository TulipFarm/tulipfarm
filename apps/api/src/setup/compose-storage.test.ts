import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(__dirname, "../../../..");

describe("Compose filesystem storage", () => {
  it("lets the worker write existing blobs without writing bootstrap secrets or Soul", () => {
    const compose = parse(readFileSync(resolve(root, "docker-compose.yml"), "utf8"));
    expect(compose.services.app.volumes).toContain("tulipfarm-data:/data");
    expect(compose.services.worker.volumes).toContain("tulipfarm-data:/data:ro");
    expect(compose.services.worker.volumes).toContainEqual({
      type: "volume",
      source: "tulipfarm-data",
      target: "/data/blobs",
      volume: { subpath: "blobs", nocopy: true },
    });
    expect(JSON.stringify(compose.services.worker.volumes)).not.toContain("tulipfarm-soul");
  });

  it("prepares the blob subdirectory before the API becomes ready", () => {
    const source = readFileSync(resolve(root, "apps/api/src/index.ts"), "utf8");
    const preparation = source.indexOf('await mkdir(join(dataDir, "blobs"), { recursive: true })');
    expect(preparation).toBeGreaterThan(-1);
    expect(preparation).toBeLessThan(source.indexOf("app.listen("));
  });
});
