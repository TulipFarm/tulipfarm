import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for L3-6: durable, cross-worker exclusion for a State's `concurrencyKey`.
 *
 * The whole point of the key is that Runs in *different* worker processes do not overlap. A store
 * held in this process's memory serializes only this process, so wiring the in-memory default into
 * production would leave the authored key silently unenforced — the exact bug L3-6 reported, with
 * a lock object added. This test reads the worker's composition as source and fails the build if a
 * site hard-wires an in-memory store instead of accepting the injected one.
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
const WORKER_SRC = join(ROOT, "apps/worker/src");
const MAIN = join(WORKER_SRC, "main.ts");

/** Every non-test `.ts` file under `directory`, read as `{ path, source }`. */
function productionSources(directory: string): readonly { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      out.push({ path: full, source: readFileSync(full, "utf8") });
  }
  return out;
}

describe("Routine State concurrencyKey durability (L3-6)", () => {
  const sources = productionSources(WORKER_SRC);

  it("finds the Routine executor composition this test is meant to guard", () => {
    // If nobody accepts a concurrency store here anymore, the invariants below are vacuous.
    const composers = sources.filter(({ source }) => /InMemoryStateConcurrencyStore/.test(source));
    expect(composers.length).toBeGreaterThan(0);
  });

  it("keeps the in-memory concurrency store only as an injected fallback", () => {
    for (const { path, source } of sources) {
      if (!/InMemoryStateConcurrencyStore/.test(source)) continue;
      // The import line is not a construction site.
      const constructs = /new InMemoryStateConcurrencyStore\(\)/.test(source);
      if (!constructs) continue;
      const guarded = /options\.concurrency\s*\?\?\s*new InMemoryStateConcurrencyStore\(\)/.test(
        source
      );
      expect(
        guarded,
        `${path} constructs InMemoryStateConcurrencyStore outside a ?? fallback`
      ).toBe(true);
    }
  });

  it("wires the durable concurrency store from the composition root into the routine executor", () => {
    const main = readFileSync(MAIN, "utf8");
    // The root builds the one durable store…
    expect(main).toMatch(/new RunStateConcurrencyStore\(/);
    // …and hands it to the Routine executor it owns.
    expect(main).toMatch(/concurrency:\s*stateConcurrencyStore\b/);
  });
});
