import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-007 fitness function: `SoulWriter` is the only door into the Soul git repository.
 *
 * The gateway exists so that every write to Soul is schema-validated, policy-checked, audited and
 * committed as one atomic, explicitly-staged changeset. A raw `fs.writeFile` into the Soul tree
 * followed by `GitSyncService.commit()` bypasses all four — and because `commit()` runs
 * `git add -A`, it also sweeps in whatever unrelated files happen to be dirty in the worktree.
 *
 * This test fails the build when new code re-opens that bypass. It does not rely on a
 * line-numbered inventory, which would rot: instead each accepted exception must carry a
 * `soul-write-exception:` marker comment at the call site explaining why it cannot use the
 * gateway, and the complete set of files holding such markers is pinned below. Adding a marker to
 * a new file is therefore a deliberate, reviewable act rather than a silent regression.
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

/** Where product code lives. `packages/soul` is the gateway's own implementation, so it is exempt. */
/**
 * Product code — everything that must go *through* the gateway. `packages/soul` is deliberately
 * absent: it is the gateway's own implementation, so it is the one place allowed to touch git and
 * the Soul filesystem directly.
 */
const SCANNED_ROOTS = ["apps/api/src", "apps/worker/src", "apps/integration-worker/src"];

/** The `git add -A` ban is global — it applies to the gateway's own implementation too. */
const STAGE_SCANNED_ROOTS = [...SCANNED_ROOTS, "packages/soul/src"];

const SKIPPED = /\.test\.ts$|\.d\.ts$|__fixtures__|\/test\//;

/**
 * The two `GitSyncService` methods that staged with `git add -A`. Both were **deleted** with this
 * work; the pattern stays banned so they cannot be reintroduced. `commitPaths()` and
 * `withSyncPaths()` are the survivors: they stage only the paths they are given, so a commit can
 * never sweep up unrelated worktree state.
 */
const AMBIENT_COMMIT = /\.withSync\s*\(|\.commit\s*\(/;

/** `git add -A` with no pathspec — the staging primitive that made ambient commits possible. */
const AMBIENT_STAGE = /\.add\s*\(\s*(["'`])-A\1\s*\)/;

/**
 * A filesystem mutation whose target is derived from a Soul repository root. Reads are allowed;
 * only writes can corrupt the source of truth.
 */
const SOUL_FS_WRITE =
  /\b(writeFile|writeFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|cp|cpSync|copyFile|rename)\s*\(\s*[^;]*(gitSync\.path|soulPath|soulRoot|soulDir)/;

const EXCEPTION_MARKER = "soul-write-exception:";

/**
 * Every file permitted to hold a `soul-write-exception:` marker, with the reason it cannot be
 * expressed as an artifact-addressed changeset. Keep this list shrinking, never growing.
 */
const ACCEPTED_EXCEPTIONS: Record<string, string> = {
  "apps/api/src/setup/bootstrap.ts":
    "Headless bootstrap seeds soul.yaml before the artifact catalog and the gateway exist.",
  "apps/api/src/setup/soul-config.ts":
    "patchSoulConfig is the raw writer the first-run setup wizard is built on.",
  "apps/api/src/soul/llm-config/soul-yaml-io.ts":
    "The soul.yaml fs wrappers exist only for the headless bootstrap seed above.",
  "apps/api/src/soul/skills/bundled.ts":
    "skills/.bundled-disabled.json is a nested singleton; classifySoulPath only addresses singletons at the repo root.",
  "apps/api/src/soul/skills/tools.ts":
    "Materialising a bundled Skill copies an arbitrary companion tree and clears the nested tombstone above.",
  "packages/soul/src/scaffold-soul.ts":
    "Creates the empty Soul repository itself, before any artifact or gateway exists.",
};

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") walk(full, out);
    } else if (full.endsWith(".ts") && !SKIPPED.test(full)) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    const full = join(ROOT, root);
    return existsSync(full) ? walk(full) : [];
  });
}

/**
 * Read each tree once. Each scan below would otherwise re-walk and re-read ~600 files, and this
 * suite shares a Vitest worker pool with timing-sensitive tests that shell out to git.
 */
const cache = new Map<string, { file: string; lines: string[] }[]>();
function sources(roots: readonly string[]): { file: string; lines: string[] }[] {
  const key = roots.join(":");
  let entry = cache.get(key);
  if (!entry) {
    entry = sourceFiles(roots).map((file) => ({
      file: relative(ROOT, file),
      lines: readFileSync(file, "utf8").split("\n"),
    }));
    cache.set(key, entry);
  }
  return entry;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** A call is exempt when the marker sits on it or in the comment block immediately above it. */
function isMarked(lines: string[], index: number): boolean {
  for (let i = Math.max(0, index - 6); i <= index; i++) {
    if (lines[i].includes(EXCEPTION_MARKER)) return true;
  }
  return false;
}

function scan(
  pattern: RegExp,
  roots: readonly string[] = SCANNED_ROOTS
): { violations: Violation[]; markedFiles: Set<string> } {
  const violations: Violation[] = [];
  const markedFiles = new Set<string>();
  for (const { file, lines } of sources(roots)) {
    lines.forEach((text, index) => {
      if (!pattern.test(text)) return;
      if (isMarked(lines, index)) {
        markedFiles.add(file);
        return;
      }
      violations.push({ file, line: index + 1, text: text.trim() });
    });
  }
  return { violations, markedFiles };
}

function format(violations: Violation[]): string[] {
  return violations.map((v) => `${v.file}:${v.line}  ${v.text}`);
}

describe("ADR-007 — SoulWriter is the only door", () => {
  it("routes every Soul commit through the gateway rather than an ambient git add -A", () => {
    const { violations } = scan(AMBIENT_COMMIT);
    expect(format(violations)).toEqual([]);
  });

  it("never stages the whole worktree", () => {
    const { violations } = scan(AMBIENT_STAGE, STAGE_SCANNED_ROOTS);
    expect(format(violations)).toEqual([]);
  });

  it("never writes the Soul tree with raw filesystem calls", () => {
    const { violations } = scan(SOUL_FS_WRITE);
    expect(format(violations)).toEqual([]);
  });

  it("confines gateway exceptions to the accepted, documented set", () => {
    const marked = new Set([
      ...scan(AMBIENT_COMMIT).markedFiles,
      ...scan(AMBIENT_STAGE, STAGE_SCANNED_ROOTS).markedFiles,
      ...scan(SOUL_FS_WRITE).markedFiles,
    ]);
    const undocumented = [...marked].filter((file) => !(file in ACCEPTED_EXCEPTIONS)).sort();
    expect(undocumented).toEqual([]);
  });

  it("leaves GitSyncService with no ambient commit primitive at all", () => {
    const gitSync = readFileSync(join(ROOT, "packages/soul/src/git-sync.ts"), "utf8");
    // Removed outright rather than merely uncalled: an unused public method is an invitation.
    expect(gitSync).not.toMatch(/\basync\s+commit\s*\(/);
    expect(gitSync).not.toMatch(/\basync\s+withSync\s*\(/);
    expect(gitSync).toMatch(/\basync\s+commitPaths\s*\(/);
  });

  it("exposes no Agent-facing Tool that can commit the Soul repository directly", () => {
    const tools = readFileSync(join(ROOT, "apps/api/src/platform/tools.ts"), "utf8");
    for (const removed of ["begin_soul_batch", "end_soul_batch", "soul_repo_commit"]) {
      expect(tools).not.toContain(removed);
    }
  });

  it("keeps the gateway constructed in the production assembly", () => {
    const assembly = readFileSync(join(ROOT, "apps/api/src/index.ts"), "utf8");
    expect(assembly).toContain("createSoulWriter");
  });
});
