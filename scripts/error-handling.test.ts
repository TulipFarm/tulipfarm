import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A discarded error must be a decision, not an accident.
 *
 * `catch {}` is the one failure-signalling shape with no defensible reading: it cannot be told
 * apart from a success, it produces no log, and the caller receives a value that says the work
 * succeeded. The two instances this repo carried were both real — a dropped memory embedding, so
 * the dense arm degraded invisibly, and a failed index-queue introspection that reported "no
 * errors" to the operator asking whether indexing had failed.
 *
 * Deliberate swallowing stays legal; it just has to say why, either by naming the error and
 * handling it or by carrying a comment inside the block. That is the whole rule.
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
const SCANNED = ["apps/api/src", "apps/worker/src", "apps/integration-worker/src", "packages"];

/** `catch {}` or `catch (e) {}` — nothing between the braces but whitespace. */
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      files.push(full);
    }
  }
  walk(join(ROOT, root));
  return files;
}

function emptyCatches(): readonly string[] {
  const found: string[] = [];
  for (const root of SCANNED) {
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(EMPTY_CATCH)) {
        const line = source.slice(0, match.index).split("\n").length;
        found.push(`${relative(ROOT, file).split(sep).join("/")}:${line}`);
      }
    }
  }
  return found.sort();
}

describe("a discarded error is a decision", () => {
  it("leaves no catch block that silently discards its error", () => {
    expect(
      emptyCatches(),
      "Handle the error, log it, or say inside the catch why dropping it is correct. " +
        "An empty catch reports success for work that failed."
    ).toEqual([]);
  });
});
