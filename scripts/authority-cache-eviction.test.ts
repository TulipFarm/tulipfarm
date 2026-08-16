import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for L3-5: the per-Run authority cache must be evicted in production.
 *
 * `RoutingToolDispatch` caches one authority promise per Run id so N co-located Tool calls cost
 * one control-plane read instead of N. It has always had `forget(runId)`, and a unit test has
 * always proved that `forget` works — but nothing in production called it, so a long-lived worker
 * retained an entry for every Run that ever touched a co-located Tool. A unit test on the method
 * cannot catch that regression: only a test that reads the composition can.
 *
 * The eviction point is the Run dispatch handler, because every co-located dispatch this process
 * makes happens inside it and is awaited by it. Evicting anywhere later would leave the Runs most
 * likely to be abandoned — parked, cancelled, reconciled elsewhere — uncollected.
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
const DISPATCH = join(WORKER_SRC, "tools/routing-dispatch.ts");

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

/** The text of the first argument to `new <name>(`, by balanced-brace scan. */
function constructorArgument(source: string, name: string): string {
  const start = source.indexOf(`new ${name}(`);
  if (start < 0) throw new Error(`no construction site for ${name}`);
  let depth = 0;
  for (let i = source.indexOf("(", start); i < source.length; i += 1) {
    const char = source[i];
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced construction site for ${name}`);
}

describe("per-Run authority cache eviction (L3-5)", () => {
  const dispatchSource = readFileSync(DISPATCH, "utf8");
  const main = readFileSync(MAIN, "utf8");

  it("finds the per-Run authority cache this test is meant to guard", () => {
    // If the cache is gone, eviction is moot and the assertions below are vacuous — fail loud
    // rather than pass by absence.
    expect(dispatchSource).toMatch(/private readonly authorities = new Map</);
    expect(dispatchSource).toMatch(/\bforget\(runId: string\): void/);
  });

  it("keeps the failed-read eviction inside the cache itself", () => {
    // A transient authority failure must not be cached, and must fall back rather than deny.
    const authorityFor = dispatchSource.slice(dispatchSource.indexOf("private authorityFor("));
    expect(authorityFor).toMatch(/this\.authorities\.delete\(runId\)/);
  });

  it("has at least one production caller of forget", () => {
    // This is the exact count that was zero when L3-5 was filed.
    const callers = productionSources(WORKER_SRC).filter(({ source }) => /\.forget\(/.test(source));
    expect(callers.length).toBeGreaterThan(0);
  });

  it("evicts from the Run dispatch handler, where no further dispatch can follow", () => {
    const dispatcher = constructorArgument(main, "RunDispatcher");
    // The handler is the only place a co-located Tool call can originate…
    expect(dispatcher).toMatch(/executors\.execute\(run\)/);
    // …and eviction must be unconditional, so a failed, parked, cancelled or thrown attempt
    // drops its entry exactly like a clean completion does.
    expect(dispatcher).toMatch(/finally\s*\{[^}]*\.forget\(run\.id\)/);
  });

  it("routes every co-located Tool call through the dispatcher the handler evicts from", () => {
    // If a second consumer is handed the router, the handler's eviction no longer bounds the map.
    const uses = main.match(/\btoolDispatch\b/g) ?? [];
    const consumers = main.match(/tools:\s*toolDispatch\b/g) ?? [];
    expect(consumers.length).toBe(1);
    // construction, the single consumer, and the eviction call.
    expect(uses.length).toBe(3);
  });
});
