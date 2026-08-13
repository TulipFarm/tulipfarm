/**
 * Fitness check: the deployment role catalog must cite the code that enforces it.
 *
 * The Roles view is generated from `roles.ts`, but the actual gates live in route and service
 * files. This ratchet keeps those two sources from drifting apart: stale `enforcedIn` paths fail,
 * and a new admin role check must be connected to an admin-only or owner-scoped catalog entry.
 *
 * This intentionally does not try to prove every handler in a cited file has one reachability
 * shape. Files such as `secrets/routes.ts` and `identity/routes.ts` legitimately contain both
 * member-reachable handlers and admin-only handlers; file-level scanning cannot split them without
 * false positives. The sound check is narrower: a file cited only as member-allowed must not also
 * contain an admin role gate.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_ONLY_SURFACES, MEMBER_ALLOWED_SURFACES, OWNER_SCOPED_SURFACES } from "./roles";

const SRC_ROOT = resolve(process.cwd(), "src");
/**
 * Both admin-gate idioms in use. The literal comparison is what every `requireAdmin` helper
 * currently expands to, so matching it alone would be sufficient *today* — each helper is defined
 * locally in the file that uses it. Matching `requireAdmin` as well keeps the ratchet honest if
 * anyone later extracts it into a shared module: the shared file would still carry the literal,
 * but every importing file would silently drop off this scan, which is exactly the drift this
 * test exists to prevent.
 */
const ADMIN_ROLE_GATE = /\brole\s*(?:!==|===)\s*["']admin["']|\brequireAdmin\b/;

interface EnforcedSurface {
  readonly type: string;
  readonly actions?: readonly string[];
  readonly enforcedIn: string;
}

interface CatalogEntry {
  readonly kind: "ADMIN_ONLY_SURFACES" | "MEMBER_ALLOWED_SURFACES" | "OWNER_SCOPED_SURFACES";
  readonly surface: EnforcedSurface;
}

interface CitedPath {
  readonly entry: CatalogEntry;
  readonly path: string;
}

function catalogEntries(): readonly CatalogEntry[] {
  return [
    ...ADMIN_ONLY_SURFACES.map((surface) => ({
      kind: "ADMIN_ONLY_SURFACES" as const,
      surface,
    })),
    ...MEMBER_ALLOWED_SURFACES.map((surface) => ({
      kind: "MEMBER_ALLOWED_SURFACES" as const,
      surface,
    })),
    ...OWNER_SCOPED_SURFACES.map((surface) => ({
      kind: "OWNER_SCOPED_SURFACES" as const,
      surface,
    })),
  ];
}

function entryLabel(entry: CatalogEntry): string {
  const actions = entry.surface.actions?.join(", ") ?? "owner-scoped deny";
  return `${entry.kind} ${entry.surface.type} [${actions}] enforcedIn="${entry.surface.enforcedIn}"`;
}

function enforcedPaths(entry: CatalogEntry): readonly string[] {
  return entry.surface.enforcedIn
    .split(";")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function citedPaths(entries: readonly CatalogEntry[]): readonly CitedPath[] {
  return entries.flatMap((entry) => enforcedPaths(entry).map((path) => ({ entry, path })));
}

function pathsFor(
  entries: readonly CatalogEntry[],
  kind: CatalogEntry["kind"]
): ReadonlySet<string> {
  return new Set(
    citedPaths(entries.filter((entry) => entry.kind === kind)).map(({ path }) => path)
  );
}

function sourceRelativePath(fullPath: string): string {
  return relative(SRC_ROOT, fullPath).split(sep).join("/");
}

function sourceFiles(): readonly string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      files.push(sourceRelativePath(fullPath));
    }
  }

  walk(SRC_ROOT);
  return files.sort();
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function adminGateFiles(): readonly string[] {
  return sourceFiles().filter((path) =>
    ADMIN_ROLE_GATE.test(withoutComments(readFileSync(join(SRC_ROOT, path), "utf8")))
  );
}

function invalidCitedPathProblem({ entry, path }: CitedPath): string | undefined {
  if (isAbsolute(path) || path.split("/").includes("..")) {
    return `${entryLabel(entry)} cites "${path}", which must stay relative to apps/api/src`;
  }

  if (!existsSync(join(SRC_ROOT, path))) {
    return `${entryLabel(entry)} cites missing file "${path}". Rename the citation or restore the file.`;
  }

  return undefined;
}

describe("role catalog fitness", () => {
  const entries = catalogEntries();
  const cited = citedPaths(entries);
  const adminOnlyPaths = pathsFor(entries, "ADMIN_ONLY_SURFACES");
  const memberAllowedPaths = pathsFor(entries, "MEMBER_ALLOWED_SURFACES");
  const ownerScopedPaths = pathsFor(entries, "OWNER_SCOPED_SURFACES");

  it("resolves every enforcedIn citation to a source file", () => {
    const problems = cited.flatMap((citation) => {
      const problem = invalidCitedPathProblem(citation);
      return problem === undefined ? [] : [problem];
    });

    expect(problems, "Fix stale role catalog citations in apps/api/src/identity/roles.ts.").toEqual(
      []
    );
  });

  it("cites every source file with an admin role gate", () => {
    const uncited = adminGateFiles().filter(
      (path) => !adminOnlyPaths.has(path) && !ownerScopedPaths.has(path)
    );

    expect(
      uncited.map(
        (path) =>
          `${path} contains an admin gate (role ===/!== "admin", or requireAdmin) but is ` +
          "absent from ADMIN_ONLY_SURFACES and OWNER_SCOPED_SURFACES. Add the enforcing file to " +
          "the right roles.ts entry, or add an owner-scoped entry if members keep self-service " +
          "access."
      ),
      "Every admin gate needs a catalog citation so the Roles view cannot silently drift."
    ).toEqual([]);
  });

  it("does not cite admin-gated files as member-only surfaces", () => {
    const gateFiles = new Set(adminGateFiles());
    const memberOnlyGateFiles = [...memberAllowedPaths]
      .filter((path) => !adminOnlyPaths.has(path) && !ownerScopedPaths.has(path))
      .filter((path) => gateFiles.has(path));

    expect(
      memberOnlyGateFiles.map(
        (path) =>
          `${path} is cited only by MEMBER_ALLOWED_SURFACES but contains an admin gate. ` +
          "Also cite it from ADMIN_ONLY_SURFACES or OWNER_SCOPED_SURFACES, or remove the stale " +
          "member-only citation."
      ),
      "A file with an admin gate cannot be represented only as member-allowed."
    ).toEqual([]);
  });
});
