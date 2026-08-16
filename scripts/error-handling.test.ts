import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A discarded error must be a decision, not an accident.
 *
 * Two catch shapes report success for work that failed and cannot be told apart from a genuine
 * success by their caller:
 *
 *   - `catch {}` — nothing between the braces. The original, narrowest case.
 *   - `catch { return <literal>; }` — the whole body is a `return` of a constant sentinel (`null`,
 *     `undefined`, `[]`, `{}`, `false`, a string, ...). This is the shape that hid L1-2: a Slack
 *     renderer throwing returned the same `null` used for "no Artifact here", so a renderer bug
 *     silently stripped a reply's action controls with no operator signal. A sentinel that doubles
 *     as "nothing here" cannot carry "it failed", and no log is emitted either way.
 *
 * Deliberate swallowing stays legal; it just has to say why, either by naming the error and
 * handling it or by carrying a comment inside the catch block (any non-whitespace between the
 * braces and the `return` clears the match). A genuine probe-and-fall-back — parse this, resolve
 * that, return nothing if it is not there — is legitimate: annotate it, do not delete the rule.
 */

/** `catch {}` or `catch (e) {}` — nothing between the braces but whitespace. */
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/**
 * `catch { return <literal>; }` — the entire body is a `return` of a constant sentinel, so the
 * error is discarded and the caller is handed a value indistinguishable from "nothing here".
 * A comment (or any statement) before the `return` breaks the match: that is the escape hatch.
 */
const SWALLOW_RETURN =
  /catch\s*(?:\([^)]*\))?\s*\{\s*return\s+(?:null|undefined|true|false|\[\s*\]|\{\s*\}|-?\d[\d_.eE]*|"[^"]*"|'[^']*'|`[^`]*`)\s*;?\s*\}/g;

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
      const relativePath = relative(ROOT, file).split(sep).join("/");
      for (const pattern of [EMPTY_CATCH, SWALLOW_RETURN]) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split("\n").length;
          found.push(`${relativePath}:${line}`);
        }
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
        "An empty catch — or one whose whole body returns a constant sentinel — reports success " +
        "for work that failed."
    ).toEqual([]);
  });
});
