import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for L7-4: published-bundle retention must actually run in production.
 *
 * `PgBundleStore.deleteUnreferencedBundles()` has always been correct — it excludes active,
 * activated, Run-pinned, audited and in-flight-publication digests — and a unit test has always
 * proved it correct. Nothing called it, so `soul_execution_bundles` grew for the life of every
 * deployment while the suite stayed green. A unit test on the method cannot catch that; only a
 * test that reads the composition of both processes can.
 *
 * The wiring has three seams, and the sweep dies silently if any one of them is cut:
 *   API schedule → pg-boss queue name → Worker consumer → the store method.
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
const API_SRC = join(ROOT, "apps/api/src");
const WORKER_SRC = join(ROOT, "apps/worker/src");
const SCHEDULE = join(API_SRC, "soul/bundle-prune-schedule.ts");
const CONSUMERS = join(WORKER_SRC, "job-consumers.ts");
const WORKER_MAIN = join(WORKER_SRC, "main.ts");
// The maintenance consumers moved out of `main.ts` when it crossed the file-size limit. They are
// still the Worker's composition root for this schedule, so the wiring is asserted where it lives.
const WORKER_MAINTENANCE = join(WORKER_SRC, "maintenance.ts");
const RETENTION = join(ROOT, "packages/soul/src/bundle-retention.ts");
const STORE = join(ROOT, "packages/soul/src/bundle-store.pg.ts");
const DEBT = join(ROOT, "scripts/reachability-debt.json");

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

describe("published bundle retention wiring (L7-4)", () => {
  const store = readFileSync(STORE, "utf8");
  const consumers = readFileSync(CONSUMERS, "utf8");
  const schedule = readFileSync(SCHEDULE, "utf8");

  it("finds the retention query this test is meant to guard", () => {
    // If the method is gone, the assertions below are vacuous — fail loud rather than by absence.
    expect(store).toMatch(/async deleteUnreferencedBundles\(/);
  });

  it("keeps every reference class excluded, so age is never the only filter", () => {
    const query = store.slice(store.indexOf("async deleteUnreferencedBundles("));
    for (const referenced of [
      "soul_active_bundles",
      "soul_bundle_activations",
      "runs",
      "audit_events",
      "soul_publications",
    ]) {
      expect(query, referenced).toContain(referenced);
    }
    // Five exclusions, each a NOT EXISTS. A deletion path that drops one is the data-loss bug.
    expect(query.match(/NOT EXISTS/g)?.length).toBe(5);
    expect(query).toContain("LIMIT $3");
  });

  it("has at least one production caller of the retention query", () => {
    // This is the exact count that was zero when L7-4 was filed.
    const callers = [...productionSources(WORKER_SRC), ...productionSources(API_SRC)].filter(
      ({ source }) => /deleteUnreferencedBundles\(|pruneUnreferencedBundles\(/.test(source)
    );
    expect(callers.length).toBeGreaterThan(0);
  });

  it("bounds every pass and never issues an unbounded delete", () => {
    const pass = readFileSync(RETENTION, "utf8");
    expect(pass).toMatch(/batch <= maxBatches/);
    expect(pass).toMatch(/if \(removed < batchSize\) return/);
    expect(pass).toMatch(/backlog: true/);
    // The consumer must go through the bounded pass, not the raw store method.
    expect(consumers).toMatch(/pruneUnreferencedBundles\(/);
    expect(consumers).not.toMatch(/\.deleteUnreferencedBundles\(/);
  });

  it("agrees on the queue name across the process boundary", () => {
    const queue = /"soul-bundle-prune"/;
    expect(schedule).toMatch(queue);
    expect(consumers).toMatch(queue);
  });

  it("registers the schedule from the API composition root", () => {
    const index = readFileSync(join(API_SRC, "index.ts"), "utf8");
    expect(index).toMatch(
      /registerSoulBundlePruneSchedule\(boss, bundleRetentionMs\(process\.env\)\)/
    );
  });

  it("hands the Worker composition root a real bundle store", () => {
    const maintenance = readFileSync(WORKER_MAINTENANCE, "utf8");
    // Without this argument the consumer is never registered and the schedule fires into nothing.
    expect(maintenance).toMatch(/bundles:\s*new PgBundleStore\(o\.transactions\)/);
  });

  it("no longer carries the method as reachability debt", () => {
    // The ledger records debt; wiring discharges it. A stale entry must not outlive the fix.
    expect(readFileSync(DEBT, "utf8")).not.toContain("PgBundleStore.deleteUnreferencedBundles");
  });
});
