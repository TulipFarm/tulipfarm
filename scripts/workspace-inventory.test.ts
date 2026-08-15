import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The map and the territory must agree, in both directions.
 *
 * Root `AGENTS.md` is the index every agent is told to navigate by, so a row
 * that describes a package which is really one line of `export {};` costs
 * every reader who believes it — and a real, 1,155-line package missing from
 * the table costs everyone who never finds it. Both had happened, along with
 * an orphaned directory carrying no `package.json` at all.
 *
 * Documentation drifts because nothing checks it. This does. It asserts that
 * the set of workspaces on disk and the set of workspaces in the table are the
 * same set, that no workspace is a placeholder, and that no directory is
 * pretending to be one.
 */

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
const WORKSPACE_ROOTS = ["apps", "packages"] as const;

interface Workspace {
  /** Repo-relative directory, e.g. `packages/soul`. */
  path: string;
  name: string;
  /** Non-test source lines under `src/` (or `app/` for the Remix app). */
  sourceLines: number;
}

function sourceLineCount(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".turbo", ".next", "coverage", "build"].includes(entry.name)) {
          continue;
        }
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        total += readFileSync(full, "utf8").split("\n").length;
      }
    }
  };
  walk(dir);
  return total;
}

function discover(): { workspaces: Workspace[]; orphans: string[] } {
  const workspaces: Workspace[] = [];
  const orphans: string[] = [];
  for (const base of WORKSPACE_ROOTS) {
    const baseDir = join(ROOT, base);
    for (const entry of readdirSync(baseDir)) {
      const dir = join(baseDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      const relPath = `${base}/${entry}`;
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) {
        orphans.push(relPath);
        continue;
      }
      const name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
      workspaces.push({ path: relPath, name, sourceLines: sourceLineCount(dir) });
    }
  }
  return { workspaces, orphans };
}

const { workspaces, orphans } = discover();
const agentsIndex = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

/** Every `apps/x` or `packages/x` path the root index links to. */
const documented = new Set(
  [...agentsIndex.matchAll(/\(((?:apps|packages)\/[a-z0-9-]+)\/AGENTS\.md\)/g)].map((m) => m[1])
);

/**
 * Workspaces the index deliberately does not link, with the reason. Both are
 * build configuration rather than code an agent navigates to.
 */
const UNLISTED_BY_DESIGN: Readonly<Record<string, string>> = {
  "packages/tsconfig": "tsconfig bases; named in the shared-config row without its own page",
  "apps/docs": "linked as apps/docs earlier in the file",
};

describe("every workspace on disk is in the root index", () => {
  for (const workspace of workspaces) {
    const reason = UNLISTED_BY_DESIGN[workspace.path];
    it(`${workspace.path} is documented${reason ? " or exempt" : ""}`, () => {
      expect(documented.has(workspace.path) || Boolean(reason)).toBe(true);
    });
  }
});

describe("every workspace in the root index is on disk", () => {
  const onDisk = new Set(workspaces.map((w) => w.path));
  for (const path of documented) {
    it(`${path} exists`, () => {
      expect(onDisk.has(path)).toBe(true);
    });
  }
});

describe("no workspace is a placeholder", () => {
  /**
   * `packages/types`, `ui` and `utils` were each one line of `export {};` with
   * no consumer, while the index described them as real. A package that holds
   * nothing is a promise the repo does not keep; the fix is to delete it, not
   * to document the emptiness.
   */
  const MINIMUM_LINES = 10;
  for (const workspace of workspaces) {
    if (workspace.path === "packages/tsconfig") continue; // JSON only, by design.
    it(`${workspace.path} holds real source`, () => {
      expect(workspace.sourceLines).toBeGreaterThan(MINIMUM_LINES);
    });
  }
});

describe("no directory pretends to be a workspace", () => {
  it("every directory under apps/ and packages/ has a package.json", () => {
    // `packages/validation` sat here for months: no manifest, no `src`, and a
    // `node_modules` that made it look inhabited.
    expect(orphans).toEqual([]);
  });
});

describe("no workspace is consumed by nothing", () => {
  /**
   * A package with no importer is either unfinished or abandoned, and the
   * index cannot tell you which. Applications are roots and have no importer
   * by definition; anything else must be named here with a reason.
   */
  const NO_CONSUMER_BY_DESIGN: Readonly<Record<string, string>> = {
    "packages/testkit":
      "shared test fixtures with no adopter yet; tracked as reachability debt, not load-bearing",
    "packages/tsconfig": "consumed through tsconfig `extends`, which is not an import",
  };

  const manifests = workspaces.map((workspace) => ({
    workspace,
    text: readFileSync(join(ROOT, workspace.path, "package.json"), "utf8"),
  }));

  for (const workspace of workspaces) {
    if (workspace.path.startsWith("apps/")) continue;
    const reason = NO_CONSUMER_BY_DESIGN[workspace.path];
    it(`${workspace.path} has a consumer${reason ? " or a stated reason" : ""}`, () => {
      const consumers = manifests.filter(
        (m) => m.workspace.path !== workspace.path && m.text.includes(`"${workspace.name}"`)
      );
      expect(consumers.length > 0 || Boolean(reason)).toBe(true);
    });
  }
});

/**
 * The four packages deleted when this file was written: three one-line
 * `export {}` stubs and one directory with no `package.json` at all.
 *
 * Deleting a directory is the easy half. The half that actually reintroduces
 * the defect is a reference that outlives it — a dependency entry, a tsconfig
 * path alias, or an import — because that is what makes the map disagree with
 * the territory again. `CHANGELOG.md` and archived plans are excluded: they
 * are history, and history is supposed to mention things that no longer exist.
 */
const DELETED_PACKAGES = ["types", "ui", "utils", "validation"] as const;

function liveConfigAndSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) || /^(package|tsconfig.*)\.json$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const root of WORKSPACE_ROOTS) walk(join(ROOT, root));
  out.push(join(ROOT, "package.json"), join(ROOT, "tsconfig.json"));
  return out.filter((file) => existsSync(file));
}

const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".next",
  "coverage",
  "build",
  ".absolute-work",
]);

describe("nothing still points at a package that was deleted", () => {
  const files = liveConfigAndSourceFiles();

  for (const pkg of DELETED_PACKAGES) {
    it(`no live file references @tulipfarm/${pkg}`, () => {
      const needle = new RegExp(`@tulipfarm/${pkg}(?![\\w-])`);
      const offenders = files
        .filter((file) => file !== __filename)
        .filter((file) => needle.test(readFileSync(file, "utf8")))
        .map((file) => file.slice(ROOT.length + 1));
      expect(offenders).toEqual([]);
    });

    it(`packages/${pkg} is not on disk`, () => {
      expect(existsSync(join(ROOT, "packages", pkg))).toBe(false);
    });
  }
});
