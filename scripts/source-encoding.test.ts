import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source files must be text, so that text tools can see them.
 *
 * A literal NUL byte is legal inside a TypeScript string and is a genuinely useful composite-key
 * separator, because it cannot occur in the names being joined. Written as a raw byte rather than
 * the `\u0000` escape it also makes the whole file binary: `grep` and `ripgrep` skip binary files
 * by default, so the file silently disappears from every text search — code review, refactors, and
 * the grep-shaped fitness checks this repo relies on to notice drift.
 *
 * The escape compiles to the identical character, so this costs nothing and keeps the file
 * readable by everything. Three files had drifted this way when the rule was added.
 */

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".json", ".md"];
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  ".vitest-reports",
  ".git",
  ".claude",
  ".worktrees",
]);

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

function filesContainingNul(directory: string, root: string, found: string[]): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      filesContainingNul(full, root, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    if (readFileSync(full).includes(0)) found.push(relative(root, full));
  }
  return found;
}

describe("source files are text, not binary", () => {
  it("has no raw NUL byte in any source file", () => {
    const root = repoRoot();

    expect(
      filesContainingNul(root, root, []),
      "These files contain a literal NUL byte, which makes grep and ripgrep treat them as " +
        "binary and skip them. Write the character as the escape `\\u0000` instead — it " +
        "compiles to the same value and leaves the file searchable."
    ).toEqual([]);
  });
});
