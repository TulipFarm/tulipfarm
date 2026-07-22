/**
 * Filesystem scanner that turns the monorepo's TypeScript sources into the
 * `ImportGraph` consumed by `checkArchitecture`. Only `@tulipfarm/*` imports
 * between discovered workspaces are recorded; external packages are ignored.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ImportGraph } from "./architecture-rules.ts";

const WORKSPACE_ROOTS = ["packages", "apps"] as const;
const SCOPE_PREFIX = "@tulipfarm/";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  ".vitest-reports",
]);
// `tsconfig` is a build-config package, not a runtime import target.
const NON_RUNTIME_NODES = new Set(["tsconfig"]);

export interface Workspace {
  shortName: string;
  dir: string;
}

/** Discover `@tulipfarm/*` workspaces under `packages/*` and `apps/*`. */
export function discoverWorkspaces(root: string): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const base of WORKSPACE_ROOTS) {
    const baseDir = path.join(root, base);
    let entries: string[];
    try {
      entries = readdirSync(baseDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(baseDir, entry);
      const manifestPath = path.join(dir, "package.json");
      let name: unknown;
      try {
        name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
      } catch {
        continue;
      }
      if (typeof name !== "string" || !name.startsWith(SCOPE_PREFIX)) continue;
      const shortName = name.slice(SCOPE_PREFIX.length);
      if (NON_RUNTIME_NODES.has(shortName)) continue;
      workspaces.push({ shortName, dir });
    }
  }
  return workspaces;
}

/** Build the cross-package import graph for the repository rooted at `root`. */
export function scanImports(root: string): ImportGraph {
  const workspaces = discoverWorkspaces(root);
  const known = new Set(workspaces.map((w) => w.shortName));
  const graph: ImportGraph = {};

  for (const { shortName, dir } of workspaces) {
    const edges = new Set<string>();
    for (const file of sourceFiles(dir)) {
      for (const target of tulipImports(file)) {
        if (target === shortName || !known.has(target) || NON_RUNTIME_NODES.has(target)) continue;
        edges.add(target);
      }
    }
    graph[shortName] = [...edges].sort();
  }
  return graph;
}

function* sourceFiles(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* sourceFiles(full);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

/** Extract the `@tulipfarm/*` short-names imported by a single source file. */
function tulipImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const info = ts.preProcessFile(text, /*readImportFiles*/ true, /*detectJavaScriptImports*/ true);
  const targets: string[] = [];
  for (const { fileName } of info.importedFiles) {
    if (!fileName.startsWith(SCOPE_PREFIX)) continue;
    // "@tulipfarm/foo" and "@tulipfarm/foo/bar" both map to "foo".
    targets.push(fileName.slice(SCOPE_PREFIX.length).split("/")[0]);
  }
  return targets;
}
