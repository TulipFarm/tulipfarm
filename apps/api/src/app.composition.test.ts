import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Boot-composition guard.
 *
 * `buildApp` gates whole feature areas on optional `AppOptions` entries. An option that `app.ts`
 * reads but `index.ts` never passes silently removes every route behind it: lint, typecheck, and
 * unit tests all stay green because the tests supply the option themselves. This test compares the
 * two files directly so a route area can only be absent from the running server on purpose.
 */

const appSource = readFileSync(join(__dirname, "app.ts"), "utf8");
const indexSource = readFileSync(join(__dirname, "index.ts"), "utf8");

/**
 * Options deliberately not composed yet. Each entry must name the PR that lands it — deferral is a
 * decision with an owner, never a silent omission.
 */
const DEFERRED_OPTIONS: Readonly<Record<string, string>> = {
  // PR 4: PR 3 gave the worker executors for `chat` and `integration`, and the Routine executor
  // landed across PR 4's own worker slices — `triggerInvoke` is now composed. `hookIngress` still
  // resolves *webhook* Triggers, which need signature-verification/secret plumbing that does not
  // exist yet.
  hookIngress: "PR 4 — Routine/Trigger consumers on the worker",
  // Replay recompiles the recorded Routine and re-executes it; the run-event stream it reads is
  // only half of what it needs.
  runReplay: "PR 4 — Routine/Trigger consumers on the worker",
  // PR 4: the @tulipfarm/routine-engine subtree is being retired, not revived.
  routines: "PR 4 — jobs and tool effects to their owners",
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
  for (const line of source.slice(start, end).split("\n")) {
    // Depth-1 entries are indented exactly six spaces inside `const app = await buildApp({`.
    const match = line.match(/^ {6}(\w+)[,:]/);
    if (match?.[1]) keys.add(match[1]);
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
