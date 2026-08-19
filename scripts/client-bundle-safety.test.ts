import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The browser bundle may not reach a Node-only module.
 *
 * `apps/web` is a client-only SPA (`remix({ ssr: false })`), so there is no server half to hide a
 * Node import in: every **value** import in `app/` is shipped to and evaluated by the browser. A
 * workspace barrel (`packages/<name>/src/index.ts`) re-exports that package's whole surface,
 * including the halves that open a socket, hash with `node:crypto`, or render a PDF. Importing one
 * value from a barrel therefore drags all of it into the browser, where evaluating it throws
 * `process is not defined` and the app shell dies with a blank "Application Error".
 *
 * This is invisible to every other check in the repo. Lint, `tsc`, and the unit suites all resolve
 * the same TypeScript source the bundler does, and none of them evaluate it in a browser — so this
 * shipped once already, green.
 *
 * Two ways out, both already used by client code that predates this test:
 *
 * - `import type { … }` — erased before the bundler sees it, so a barrel is safe.
 * - a **subpath** export (`@tulipfarm/files/limits`) — resolves to one leaf module, so nothing
 *   else in the package is reachable.
 *
 * Add a package to `BARREL_IS_NODE_ONLY` when its barrel reaches Node-only code. Add a subpath to
 * that package's `exports` map rather than widening this list.
 */

const REPO_ROOT = join(import.meta.dirname, "..");
const CLIENT_ROOT = join(REPO_ROOT, "apps/web/app");

/** Workspace packages whose barrel reaches code the browser cannot evaluate. */
const BARREL_IS_NODE_ONLY: Record<string, string> = {
  "@tulipfarm/files": "src/render.ts loads pdfkit, and the service/repo halves are Node-only",
  "@tulipfarm/schema": "src/registry.ts imports node:crypto",
  "@tulipfarm/storage": "opens database and blob connections",
  "@tulipfarm/soul": "reads the soul repo from disk",
  "@tulipfarm/knowledge": "reaches the vector store",
  "@tulipfarm/audit": "reaches the audit tables",
  "@tulipfarm/secrets": "imports node:crypto",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every bare-barrel import of `pkg`, paired with whether it was type-only.
 *
 * Matches the whole statement rather than the line so a multi-line import — which is what Biome
 * produces once a clause passes the 100-column line width — is read as one import instead of
 * slipping through as an unrecognised fragment.
 */
function barrelImports(source: string, pkg: string): { typeOnly: boolean; text: string }[] {
  // `[^;]` keeps the clause inside one statement: a greedy dot would start at an earlier
  // import and swallow the `type` marker of this one, reading a type-only import as a value.
  const pattern = new RegExp(`import\\s+([^;]*?)\\s*from\\s*["']${pkg}["']`, "g");
  const found: { typeOnly: boolean; text: string }[] = [];
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? "";
    // `import type { A }` is erased wholesale. `import { type A, b }` is not: `b` is a value.
    const typeOnly = clause.startsWith("type ");
    found.push({ typeOnly, text: match[0].replace(/\s+/g, " ") });
  }
  return found;
}

describe("the client bundle never evaluates a Node-only module", () => {
  const files = sourceFiles(CLIENT_ROOT);

  it("finds the client source to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("value-imports no workspace barrel that reaches Node-only code", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pkg of Object.keys(BARREL_IS_NODE_ONLY)) {
        for (const found of barrelImports(source, pkg)) {
          if (found.typeOnly) continue;
          offenders.push(`${relative(REPO_ROOT, file)}\n    ${found.text}`);
        }
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `A client module value-imports a workspace barrel that reaches Node-only code.\n` +
            `Import a subpath (e.g. "@tulipfarm/files/limits") or make it "import type".\n\n` +
            `${offenders.join("\n")}\n`
    ).toEqual([]);
  });

  it("keeps a subpath export for every leaf the client imports", () => {
    const missing: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s*["'](@tulipfarm\/[a-z-]+)\/([a-z-]+)["']/g)) {
        const [, pkg, subpath] = match;
        if (pkg === undefined || subpath === undefined) continue;
        const manifestPath = join(
          REPO_ROOT,
          "packages",
          pkg.replace("@tulipfarm/", ""),
          "package.json"
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          exports?: Record<string, string>;
        };
        if (manifest.exports?.[`./${subpath}`] === undefined) {
          missing.push(
            `${relative(REPO_ROOT, file)} imports ${pkg}/${subpath}, not in its exports`
          );
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
