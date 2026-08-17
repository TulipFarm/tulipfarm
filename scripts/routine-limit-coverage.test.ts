import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMIT_KEYS, type LimitKey } from "../packages/run-kernel/src/limits";
import { ROUTINE_BOUND_CEILINGS } from "../packages/run-kernel/src/routine/compiler";
import {
  BOUND_BY_LIMIT_KEY,
  ENFORCEMENT_SURFACE_BY_LIMIT_KEY,
  LEDGER_METERED_LIMIT_KEYS,
  RETRY_METERED_LIMIT_KEYS,
} from "../packages/run-kernel/src/routine/limit-enforcement";

/**
 * Fitness function for L3-10: no limit key may exist that nothing meters.
 *
 * Six of the twelve declared keys were validated, resolved, non-amplification-checked, and then
 * reached nothing at all — an author could bound `networkBytes` and receive no bound. Unit tests
 * on each piece stayed green throughout, because every piece worked; only the join was missing.
 *
 * These assertions fail if a key is ever added back to `LIMIT_KEYS` without landing on one of the
 * three surfaces that actually count something, and if the authored schema and the runtime key
 * set ever drift apart. A key nothing meters must be absent, so declaring it is a validation
 * error the author sees, not silence.
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
const AUTHORED_LIMITS = join(ROOT, "packages/run-kernel/src/routine/authored-limits.ts");
const COMPILER = join(ROOT, "packages/run-kernel/src/routine/compiler.ts");
const EXECUTOR = join(ROOT, "apps/worker/src/routine/executor.ts");

const boundKeys = new Set<string>(Object.keys(BOUND_BY_LIMIT_KEY));
const ledgerKeys = new Set<string>(LEDGER_METERED_LIMIT_KEYS);
const retryKeys = new Set<string>(RETRY_METERED_LIMIT_KEYS);

/** The surfaces that carry a key, read from the maps production actually applies. */
function enforcingSurfaces(key: LimitKey): readonly string[] {
  return [
    ...(boundKeys.has(key) ? ["bounds"] : []),
    ...(ledgerKeys.has(key) ? ["ledger"] : []),
    ...(retryKeys.has(key) ? ["retry"] : []),
  ];
}

describe("every limit key reaches an enforcement surface (L3-10)", () => {
  it.each(LIMIT_KEYS)("enforces %s on exactly one surface", (key) => {
    // One surface, not zero (the L3-10 bug) and not two (two ceilings that can disagree).
    const surfaces = enforcingSurfaces(key);
    expect(
      surfaces,
      `limit key "${key}" is metered by ${surfaces.length} surfaces; enforce it on exactly one ` +
        "of bounds/ledger/retry, or delete the key so authoring it fails validation"
    ).toHaveLength(1);
    expect(surfaces[0]).toBe(ENFORCEMENT_SURFACE_BY_LIMIT_KEY[key]);
  });

  it("declares an enforcement surface for exactly the keys that exist", () => {
    expect(Object.keys(ENFORCEMENT_SURFACE_BY_LIMIT_KEY).sort()).toEqual([...LIMIT_KEYS].sort());
  });

  it("routes every surface's keys to a target the runtime reads", () => {
    // A bound key must name a real `CompiledBounds` field, which is what the processors check.
    for (const bound of Object.values(BOUND_BY_LIMIT_KEY)) {
      expect(Object.keys(ROUTINE_BOUND_CEILINGS)).toContain(bound);
    }
    for (const key of [...boundKeys, ...ledgerKeys, ...retryKeys]) {
      expect(LIMIT_KEYS).toContain(key);
    }
  });

  it("applies each surface's narrowing at the site that owns it", () => {
    const compiler = readFileSync(COMPILER, "utf8");
    expect(compiler).toMatch(/bounds:\s*narrowBoundsByLimits\(/);
    expect(compiler).toMatch(/retry:\s*narrowRetryByLimits\(/);

    // The ledger keys are the ones the Agent loop debits; the executor opens them per Run.
    const executor = readFileSync(EXECUTOR, "utf8");
    expect(executor).toMatch(/routineBudgetScopedLimits\(this\.ctx\.routine\)/);
  });

  it("enforces the State retry ceiling the `retries` limit narrows", () => {
    const executor = readFileSync(EXECUTOR, "utf8");
    expect(executor).toMatch(/made\s*>=\s*policy\.maxAttempts/);
  });

  it("keeps the authored vocabulary and the runtime key set in step", () => {
    // Every authored key maps to a runtime key, so nothing authorable is left unmetered.
    const authored = readFileSync(AUTHORED_LIMITS, "utf8");
    const mapped = [...authored.matchAll(/key:\s*"([a-zA-Z]+)"/g)].map(([, key]) => key);
    expect(mapped.length).toBeGreaterThan(0);
    for (const key of mapped) expect(LIMIT_KEYS).toContain(key);
  });
});

const RUN_STORE = join(ROOT, "packages/storage/src/runs/run-store.ts");

/** Every non-test `.ts` file under `directory`, read as source. */
function productionSources(directory: string): readonly { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      out.push({ path: full, source: readFileSync(full, "utf8") });
  }
  return out;
}

function workspaceSources(): readonly { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const workspace of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, workspace), { withFileTypes: true })) {
      const src = join(ROOT, workspace, entry.name, "src");
      if (entry.isDirectory() && existsSync(src)) out.push(...productionSources(src));
    }
  }
  return out;
}

/**
 * A Run bound is only readable through the `bounds` value it lives in, so that is what a reader
 * has to name. Matching the bare field name would count `job.attempts` in an unrelated queue as
 * proof that `bounds.attempts` is enforced, which is the very illusion this file exists to stop.
 */
function hasBoundsReader(sources: readonly { path: string; source: string }[], field: string) {
  const reader = new RegExp(`(^|[^A-Za-z])bounds\\??\\.${field}\\b`, "m");
  return sources.some(({ path, source }) => path !== RUN_STORE && reader.test(source));
}

/** Keys a `jsonb` column's `?& ARRAY[...]` presence check makes mandatory on every row. */
function requiredJsonbKeys(sql: string): readonly string[] {
  return [...sql.matchAll(/\?&\s*ARRAY\[([^\]]*)\]/g)].flatMap(([, list]) =>
    [...list.matchAll(/'([^']+)'/g)].map(([, key]) => key)
  );
}

/** Fields of any `*Bounds` interface the Run store declares. */
function declaredBoundsFields(source: string): readonly string[] {
  return [...source.matchAll(/interface\s+\w*Bounds\s*\{([^}]*)\}/g)].flatMap(([, body]) =>
    [...body.matchAll(/(?:readonly\s+)?(\w+)\s*[?:]/g)].map(([, field]) => field)
  );
}

describe("no Run field is required without a reader (L3-10)", () => {
  const runStore = readFileSync(RUN_STORE, "utf8");

  it("requires no `bounds` JSONB key that nothing reads", () => {
    const sources = workspaceSources();
    const unread = requiredJsonbKeys(runStore).filter((key) => !hasBoundsReader(sources, key));
    expect(
      unread,
      `the runs table makes ${unread.join(", ")} mandatory, but no production module reads them; ` +
        "give each a reader or drop it from the interface, the CHECK, and every fixture"
    ).toEqual([]);
  });

  it("declares no bounds field that nothing reads", () => {
    const sources = workspaceSources();
    const unread = declaredBoundsFields(runStore).filter((f) => !hasBoundsReader(sources, f));
    expect(unread).toEqual([]);
  });
});
