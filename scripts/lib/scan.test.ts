import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARCHITECTURE_CONFIG, checkArchitecture } from "./architecture-rules.ts";
import { discoverWorkspaces, scanImports } from "./scan.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("scanImports (real repo)", () => {
  it("discovers every workspace package and app", () => {
    const names = discoverWorkspaces(repoRoot).map((w) => w.shortName);
    expect(names).toContain("schema");
    expect(names).toContain("soul");
    expect(names).toContain("api");
    expect(names).toContain("web");
  });

  it("captures the known legacy edges", () => {
    const graph = scanImports(repoRoot);
    expect(graph.soul).toContain("constants");
    expect(graph.api).toEqual(expect.arrayContaining(["llm", "soul"]));
  });

  it("leaves the current tree free of architecture violations", () => {
    const violations = checkArchitecture(scanImports(repoRoot), ARCHITECTURE_CONFIG);
    expect(violations).toEqual([]);
  });
});

describe("scanImports (synthetic fixture)", () => {
  it("extracts only @tulipfarm cross-package edges and skips build dirs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "arch-scan-"));
    try {
      // Register the packages the fixture imports so they are known workspaces.
      for (const name of ["schema", "authz", "audit", "secrets"]) {
        const p = path.join(root, "packages", name);
        mkdirSync(p, { recursive: true });
        writeFileSync(path.join(p, "package.json"), JSON.stringify({ name: `@tulipfarm/${name}` }));
      }
      const pkg = path.join(root, "packages", "demo");
      mkdirSync(path.join(pkg, "src"), { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@tulipfarm/demo" }));
      writeFileSync(
        path.join(pkg, "src", "index.ts"),
        [
          'import { a } from "@tulipfarm/schema";',
          'export { b } from "@tulipfarm/authz/deep/path";',
          'import { c } from "lodash";',
          'const d = await import("@tulipfarm/audit");',
        ].join("\n")
      );
      // A file under a build output dir must be ignored.
      mkdirSync(path.join(pkg, "dist"), { recursive: true });
      writeFileSync(path.join(pkg, "dist", "index.ts"), 'import "@tulipfarm/secrets";');

      const graph = scanImports(root);
      expect(new Set(graph.demo)).toEqual(new Set(["schema", "authz", "audit"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
