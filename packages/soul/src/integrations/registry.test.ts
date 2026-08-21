import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledIntegrationsDir } from "./bundled";
import { loadIntegrationRegistry } from "./registry";

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;

const temps: string[] = [];
async function withRegistry(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "registry-"));
  temps.push(dir);
  await writeFile(join(dir, "registry.yml"), content, "utf8");
  return dir;
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("loadIntegrationRegistry", () => {
  it("reads curated entries", async () => {
    const dir = await withRegistry(
      "version: 1\nintegrations:\n  - name: linear\n    title: Linear\n    category: productivity\n    source: acme/linear\n"
    );
    const registry = await loadIntegrationRegistry(logger, dir);
    expect(registry.get("linear")).toEqual({
      name: "linear",
      title: "Linear",
      category: "productivity",
      source: "acme/linear",
      description: undefined,
      homepage: undefined,
    });
  });

  // The marketplace page is more useful bare than broken, so neither absence nor malformed YAML
  // may throw.
  it("returns an empty catalog when there is no registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-empty-"));
    temps.push(dir);
    expect(await loadIntegrationRegistry(logger, dir)).toEqual(new Map());
  });

  it("logs and returns empty on malformed YAML rather than throwing", async () => {
    const dir = await withRegistry("integrations: [unclosed\n");
    expect(await loadIntegrationRegistry(logger, dir)).toEqual(new Map());
  });

  it("skips entries with no name and keeps the first of a duplicate", async () => {
    const dir = await withRegistry(
      "integrations:\n  - title: Nameless\n  - name: linear\n    title: First\n  - name: linear\n    title: Second\n"
    );
    const registry = await loadIntegrationRegistry(logger, dir);
    expect(registry.size).toBe(1);
    expect(registry.get("linear")?.title).toBe("First");
  });

  describe("the shipped catalog", () => {
    it("lists every bundled integration, so nothing ships without a display name", async () => {
      const registry = await loadIntegrationRegistry(logger, bundledIntegrationsDir());
      for (const name of ["slack", "github", "jira"]) {
        expect(registry.get(name)?.title).toBeTruthy();
        expect(registry.get(name)?.category).toBeTruthy();
      }
    });
  });
});
