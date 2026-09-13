import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOimManifest } from "../packages/schema/src";

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const CATALOG = join(ROOT, "integrations");

function catalogFiles(directory = CATALOG): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? catalogFiles(path) : [relative(ROOT, path)];
    })
    .sort();
}

function dockerIgnorePatternMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates = [path];
  let parent = posix.dirname(path);
  while (parent !== ".") {
    candidates.push(parent);
    parent = posix.dirname(parent);
  }

  if (!normalized.includes("/")) {
    return candidates.some((candidate) => posix.matchesGlob(basename(candidate), normalized));
  }
  return candidates.some((candidate) => posix.matchesGlob(candidate, normalized));
}

function ignoredCatalogFiles(): string[] {
  const patterns = readFileSync(join(ROOT, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  return catalogFiles().filter((path) => {
    let ignored = false;
    for (const line of patterns) {
      const negated = line.startsWith("!");
      const pattern = negated ? line.slice(1) : line;
      if (dockerIgnorePatternMatches(path, pattern)) ignored = !negated;
    }
    return ignored;
  });
}

describe("bundled integrations container packaging", () => {
  it("copies the complete catalog to the production loader path", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    const runtime = dockerfile.split("FROM node:26.5.0-slim AS runtime")[1];
    expect(runtime).toBeDefined();
    expect(runtime).toContain("WORKDIR /app");
    expect(runtime).toContain(
      "COPY --from=builder --chown=node:0 /app/integrations ./integrations"
    );

    const loader = readFileSync(join(ROOT, "packages/soul/src/integrations/bundled.ts"), "utf8");
    expect(loader).toContain('const IMAGE_INTEGRATIONS_DIR = "/app/integrations";');
    expect(dockerfile).toContain("COPY . .");
    expect(ignoredCatalogFiles()).toEqual([]);
  });

  it("includes every companion file declared by a bundled OIM manifest", () => {
    const packageDirectories = readdirSync(CATALOG, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    );
    const oimDirectories = packageDirectories.filter((entry) =>
      existsSync(join(CATALOG, entry.name, "oim.yml"))
    );
    expect(oimDirectories.length).toBeGreaterThan(0);

    for (const directory of oimDirectories) {
      const packageRoot = join(CATALOG, directory.name);
      const manifest = parseOimManifest(readFileSync(join(packageRoot, "oim.yml"), "utf8"));
      for (const file of manifest.files ?? []) {
        expect(
          existsSync(join(packageRoot, file.path)),
          `${directory.name}/${file.path} is declared by oim.yml but missing`
        ).toBe(true);
      }
    }
  });
});
