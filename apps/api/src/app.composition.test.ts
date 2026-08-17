import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Guards that `index.ts` wires every optional `AppOptions` dependency `buildApp` gates on. */

const appSource = readFileSync(join(__dirname, "app.ts"), "utf8");
const indexSource = readFileSync(join(__dirname, "index.ts"), "utf8");

/**
 * Options deliberately not composed yet. Each entry must name the PR that lands it — deferral is a
 * decision with an owner, never a silent omission.
 */
const DEFERRED_OPTIONS: Readonly<Record<string, string>> = {
  // Replay recompiles the recorded Routine and re-executes it; the run-event stream it reads is
  // only half of what it needs.
  runReplay: "PR 4 — Routine/Trigger consumers on the worker",
  routineAuthoring: "PR 4 — jobs and tool effects to their owners",
  // PR 6: no form storage exists, and GovernedFormView is rendered by no route.
  forms: "PR 6 — compose the governed packages",
};

/** Option keys in `app.ts` that gate at least one `registerXxxRoutes` call. */
function routeGatingOptions(source: string): Set<string> {
  const found = new Set<string>();
  const lines = source.split("\n");

  for (const [index, line] of lines.entries()) {
    // Direct pass-through: registerXxxRoutes(app, opts.foo, ...)
    const direct = line.match(/register\w*Routes\(\s*\w+\s*,\s*opts\.(\w+)/);
    if (direct?.[1]) found.add(direct[1]);

    // Guarded block: `if (opts.foo) { ... registerXxxRoutes(...) }`
    const guard = line.match(/^\s*if \(opts\.(\w+)\)/);
    if (!guard?.[1]) continue;
    const body = lines.slice(index, index + 12).join("\n");
    if (/register\w*Routes\(/.test(body)) found.add(guard[1]);
  }

  return found;
}

/**
 * What each `Pick<AppOptions, ...>` helper contributes, keyed by function name.
 *
 * Without this a spread — `...buildCurator({ ... })` — composes options the scan below cannot see,
 * so every option a helper supplies would be reported missing while in fact being wired. Reading
 * the helper's own return annotation keeps the two halves from drifting: widening the `Pick` is
 * what tells this test the new key exists.
 */
function helperContributions(root: string): Map<string, string[]> {
  const contributions = new Map<string, string[]>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        const source = readFileSync(full, "utf8");
        for (const match of source.matchAll(
          /function (\w+)\([\s\S]*?\): Pick<AppOptions,([^>]*)>/g
        )) {
          const keys = [...match[2].matchAll(/"(\w+)"/g)].map((key) => key[1]);
          if (match[1] && keys.length > 0) contributions.set(match[1], keys);
        }
      }
    }
  };
  walk(root);
  return contributions;
}

/** Top-level keys of the object literal passed to the production `buildApp` call. */
function composedOptions(source: string): Set<string> {
  const start = source.indexOf("buildApp({");
  expect(start, "index.ts must call buildApp with an object literal").toBeGreaterThan(-1);

  let depth = 0;
  let end = start;
  for (let cursor = source.indexOf("{", start); cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
  }

  const keys = new Set<string>();
  const helpers = helperContributions(__dirname);
  for (const line of source.slice(start, end).split("\n")) {
    // Depth-1 entries are indented exactly six spaces inside `const app = await buildApp({`.
    const match = line.match(/^ {6}(\w+)[,:]/);
    if (match?.[1]) keys.add(match[1]);
    const spread = line.match(/^ {6}\.\.\.(\w+)\(/);
    for (const key of (spread?.[1] && helpers.get(spread[1])) || []) keys.add(key);
  }
  return keys;
}

describe("production app composition", () => {
  const gating = routeGatingOptions(appSource);
  const composed = composedOptions(indexSource);

  it("finds the route-gating options and the composed options", () => {
    expect(gating.size).toBeGreaterThan(10);
    expect(composed.size).toBeGreaterThan(10);
  });

  it("passes every route-gating option that is not explicitly deferred", () => {
    const missing = [...gating]
      .filter((key) => !composed.has(key) && !(key in DEFERRED_OPTIONS))
      .sort();

    expect(
      missing,
      `apps/api/src/index.ts does not pass these route-gating options to buildApp, so their routes ` +
        `do not exist on the running server. Compose them, or add them to DEFERRED_OPTIONS with the ` +
        `PR that lands them.`
    ).toEqual([]);
  });

  it("keeps the deferred list honest — a deferred option must still gate real routes", () => {
    const stale = Object.keys(DEFERRED_OPTIONS)
      .filter((key) => !gating.has(key) || composed.has(key))
      .sort();

    expect(
      stale,
      "these options are listed as deferred but are already composed (or no longer gate routes) — " +
        "remove them from DEFERRED_OPTIONS"
    ).toEqual([]);
  });
});
