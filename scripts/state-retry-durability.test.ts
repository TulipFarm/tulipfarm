import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for L3-2: durable per-State retry counters across a park and resume.
 *
 * A State's `retry` policy bounds attempts by `maxAttempts`. A store constructed per execution
 * loads nothing on resume, so a State that fails, retries, parks, and is reclaimed would restart
 * its attempt count at zero and the ceiling would become per-park, not per-Run — the exact L3-4
 * bug class one layer up. Only the durable store closes that, and only if every production Routine
 * executor is wired to it. This test reads the worker's composition as source and fails the build
 * if a site hard-wires an in-memory store instead of accepting the injected one.
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

describe("Routine State retry durability (L3-2)", () => {
  const sources = productionSources(WORKER_SRC);

  it("finds the Routine executor composition this test is meant to guard", () => {
    // If nobody accepts a retry store here anymore, the invariants below are vacuous — fail loud.
    const composers = sources.filter(({ source }) => /InMemoryStateRetryStore/.test(source));
    expect(composers.length).toBeGreaterThan(0);
  });

  it("keeps the in-memory retry store only as an injected fallback", () => {
    for (const { path, source } of sources) {
      if (!/InMemoryStateRetryStore/.test(source)) continue;
      // The import line is not a construction site.
      const constructs = /new InMemoryStateRetryStore\(\)/.test(source);
      if (!constructs) continue;
      const guarded = /options\.retries\s*\?\?\s*new InMemoryStateRetryStore\(\)/.test(source);
      expect(guarded, `${path} constructs InMemoryStateRetryStore outside a ?? fallback`).toBe(
        true
      );
    }
  });

  it("wires the durable retry store from the composition root into the routine executor", () => {
    const main = readFileSync(MAIN, "utf8");
    // The root builds the one durable store…
    expect(main).toMatch(/new RunStateRetryStore\(/);
    // …and hands it to the Routine executor it owns.
    expect(main).toMatch(/retries:\s*stateRetryStore\b/);
  });
});
