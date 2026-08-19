import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A file may shrink. It may not grow past the line it is on today.
 *
 * The 600-line threshold is not a style preference. Every file on this list is
 * one an agent must read in full to change safely, and the count of files over
 * it went 13 → 38 across three editions of the architecture review — while
 * each individual wave looked reasonable. Nothing was watching the aggregate,
 * so the aggregate is what this watches.
 *
 * Two rules, and they are deliberately asymmetric:
 *
 * - A file **not** on the list must stay under `LIMIT`. Crossing it fails.
 * - A file **on** the list must stay at or below the count recorded here.
 *   Shrinking is expected; the recorded number then has to come down with it,
 *   so the list cannot record a debt that has already been paid.
 *
 * The second rule is what makes this a ratchet rather than a snapshot. An
 * entry that has been reduced and not updated fails just as loudly as one that
 * has grown, because a list that drifts out of step with the tree teaches
 * everyone to ignore it.
 *
 * Splitting a file to satisfy this test and leaving the pieces mutually
 * dependent is not a fix — it converts one long file into several files that
 * must still be read together. Move a cohesive slice to the module that owns
 * it, or do not move it.
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
const LIMIT = 600;
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  ".source",
  ".react-router",
  ".vitest-reports",
]);

/**
 * Files over `LIMIT` today, with the count they are allowed to reach. Entries
 * come off this list by shrinking below `LIMIT`, never by being edited upward.
 *
 * `apps/api/src/pg-migrations/index.ts` is the one entry that is expected to
 * grow: it is an append-only ledger of applied migrations, and rewriting
 * history to shorten it would be a defect. It carries a separate, higher
 * allowance for that reason, and that allowance moves up by exactly the size of
 * each migration appended — six lines for the Curator schema (#55), plus one
 * for the admission ledger statements it applies alongside them.
 *
 * Five allowances were re-baselined when the Task system (#384) and the egress
 * caging fix (#385) landed on main: that growth arrived through review before
 * this ratchet existed on their branch, so holding it to a baseline it never
 * saw would fail the build for work already accepted. Re-baselining against a
 * new merge-base is not the same as widening an allowance to excuse a diff,
 * which remains forbidden.
 *
 * The two entries above were re-measured after the Curator merged with #388-#390.
 * Both sides had raised them for the same reason — appended migrations — so
 * neither number described the merged file. The measurement did: the ledger
 * gained three migrations and lost 106 lines of boilerplate to `applyStatements`,
 * ending below both claims. Taking the measurement rather than the higher claim
 * is the ratchet working; keeping upstream's would have banked slack no file
 * was using.
 *
 * The ledger was re-measured again for the Knowledge graph retrieval work: five
 * migrations were appended (#69-#71 for the unified Page/Space ACL tables, #72
 * for the GraphRAG entity, edge, community and summary tables, #73 for the
 * trigger that prunes graph rows when their source chunk goes). That is 277
 * added lines, which against the old allowance would argue for 2358. The
 * measurement is 2157, because the previous allowance carried slack the file
 * was not using. Taking the measurement banks the difference back, per the
 * paragraph above.
 */
const OVERSIZED: Readonly<Record<string, number>> = {
  "apps/api/src/pg-migrations/index.ts": 2157,
  "apps/api/src/index.ts": 1314,
};

/**
 * The high-water mark for how many files may exceed `LIMIT` at once. Held
 * separately from the list so that trading one oversized file for two smaller
 * ones that are each still over the line does not read as progress.
 */
const MAX_OVERSIZED_FILES = Object.keys(OVERSIZED).length;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const measured = new Map<string, number>();
for (const base of ["apps", "packages"]) {
  for (const file of sourceFiles(join(ROOT, base))) {
    const relPath = relative(ROOT, file).split(sep).join("/");
    measured.set(relPath, readFileSync(file, "utf8").split("\n").length);
  }
}

const over = [...measured].filter(([, lines]) => lines > LIMIT).sort((a, b) => b[1] - a[1]);

describe("no file crosses the line without being recorded", () => {
  it(`every file over ${LIMIT} lines is on the list`, () => {
    const unrecorded = over
      .filter(([file]) => !(file in OVERSIZED))
      .map(([file, lines]) => `${file} (${lines})`);
    expect(unrecorded).toEqual([]);
  });

  it("the count of oversized files does not grow", () => {
    expect(over.length).toBeLessThanOrEqual(MAX_OVERSIZED_FILES);
  });
});

describe("the list only ratchets down", () => {
  for (const [file, allowance] of Object.entries(OVERSIZED)) {
    it(`${file} stays at or below ${allowance}`, () => {
      const actual = measured.get(file);
      expect(actual, `${file} is on the oversized list but no longer exists`).toBeDefined();
      expect(actual).toBeLessThanOrEqual(allowance);
    });
  }
});

describe("the list holds nothing already paid off", () => {
  it("records no file that is now under the limit", () => {
    const paid = Object.keys(OVERSIZED).filter((file) => {
      const actual = measured.get(file);
      return actual !== undefined && actual <= LIMIT;
    });
    expect(paid, "these are under the limit — delete their entries").toEqual([]);
  });

  it("records no file that no longer exists", () => {
    const gone = Object.keys(OVERSIZED).filter((file) => !measured.has(file));
    expect(gone).toEqual([]);
  });
});
