import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Routes declare what they need; one function decides.
 *
 * `authorization-design.md` D4 says there is one decision function reached through two thin
 * adapters, and that no other code may decide. An inline `role !== "admin"` in a handler is other
 * code deciding: it never reaches `decideEffectivePermission`, it carries no declaration a CI
 * ratchet or Roles view can read, and it drifts from the catalog that claims to describe it —
 * which is how members were once told they could not touch their own API tokens.
 *
 * This test pins the surfaces already migrated onto the shared gate at zero, and holds the rest as
 * a named, shrinking debt. Entries may be removed, never added, and a file that is cleaned but
 * left on the list fails too, so the list cannot rot into decoration.
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
const API_SRC = join(ROOT, "apps", "api", "src");

/** Matches both a local `requireAdmin` helper and the literal role comparison it wraps. */
const INLINE_ADMIN_DECISION = /\brole\s*(?:!==|===)\s*["']admin["']|\brequireAdmin\b/g;

/**
 * The shared gate holds the one admin comparison every `RouteAuthorization` falls back to when no
 * authorizer is wired. It is the mechanism, so it is the one place the pattern belongs.
 */
const GATE_MECHANISM = "authz/route-gate.ts";

/**
 * Decisions about the *target row* rather than the caller. `users.ts` refuses to change the admin
 * account's status so a deployment cannot lock itself out; that is a domain invariant, and routing
 * it through the authorization engine would answer a different question than the one being asked.
 */
const TARGET_ROW_INVARIANTS: Readonly<Record<string, string>> = {
  "auth/routes/users.ts": "refuses status changes to the admin account itself, not to its caller",
};

/**
 * Route modules still deciding for themselves. Empty, and it stays empty: every admin surface in
 * `apps/api` now declares a `RouteAuthorization` and lets the gate decide.
 */
const INLINE_DECISION_DEBT: Readonly<Record<string, number>> = {};

/**
 * Surfaces already migrated. Named rather than merely absent from the debt list so that
 * reintroducing an inline check into one of them fails on the file that regressed.
 */
const MIGRATED: readonly string[] = [
  "admin/runtime.ts",
  "audit/routes.ts",
  "auth/routes/tokens.ts",
  "auth/routes/users.ts",
  "authz/routes.ts",
  "identity/routes.ts",
  "index.ts",
  "integrations/auth-routes.ts",
  "integrations/github-install-routes.ts",
  "integrations/routes.ts",
  "kill-switches/routes.ts",
  "knowledge/routes.ts",
  "kv/routes.ts",
  "observability/routes.ts",
  "onboarding/routes.ts",
  "secrets/routes.ts",
  "setup/routes.ts",
  "soul/llm-config/routes.ts",
  "soul/publication-routes.ts",
  "soul/resource-types/routes.ts",
  "soul/roles/routes.ts",
  "soul/routes.ts",
];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(): readonly string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      files.push(relative(API_SRC, full).split(sep).join("/"));
    }
  }
  walk(API_SRC);
  return files.sort();
}

function inlineDecisionCounts(): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const path of sourceFiles()) {
    if (path === GATE_MECHANISM || path in TARGET_ROW_INVARIANTS) continue;
    const source = withoutComments(readFileSync(join(API_SRC, path), "utf8"));
    const found = source.match(INLINE_ADMIN_DECISION)?.length ?? 0;
    if (found > 0) counts[path] = found;
  }
  return counts;
}

describe("routes reach the one decision function", () => {
  const found = inlineDecisionCounts();

  it("adds no inline admin decision outside the recorded debt", () => {
    const undeclared = Object.keys(found).filter((path) => !(path in INLINE_DECISION_DEBT));

    expect(
      undeclared,
      "A route must declare a RouteAuthorization and let requireAuthorization decide " +
        "(authorization-design D4). Add the declaration instead of comparing a role in the handler."
    ).toEqual([]);
  });

  it("never grows the number of sites in a file that still holds debt", () => {
    const grown = Object.entries(found)
      .filter(([path, count]) => path in INLINE_DECISION_DEBT && count > INLINE_DECISION_DEBT[path])
      .map(
        ([path, count]) =>
          `${path} now has ${count} inline admin decisions, up from ${INLINE_DECISION_DEBT[path]}`
      );

    expect(grown, "Migrate a route onto the gate rather than adding another inline check.").toEqual(
      []
    );
  });

  it("drops a file from the debt list once it is clean, so the list can only shrink", () => {
    const stale = Object.entries(INLINE_DECISION_DEBT)
      .filter(([path, count]) => (found[path] ?? 0) < count)
      .map(
        ([path, count]) =>
          `${path} is down to ${found[path] ?? 0} inline admin decisions from ${count} — ` +
          "lower its count in INLINE_DECISION_DEBT, or remove the entry if it is now zero"
      );

    expect(stale, "Keep the debt list honest.").toEqual([]);
  });

  it("keeps every migrated surface free of inline admin decisions", () => {
    const regressed = MIGRATED.filter((path) => (found[path] ?? 0) > 0).map(
      (path) => `${path} was migrated onto requireAuthorization but decides inline again`
    );

    expect(regressed).toEqual([]);
  });

  it("names only files that exist", () => {
    const missing = [
      ...Object.keys(INLINE_DECISION_DEBT),
      ...Object.keys(TARGET_ROW_INVARIANTS),
      ...MIGRATED,
      GATE_MECHANISM,
    ].filter((path) => !existsSync(join(API_SRC, path)));

    expect(missing, "Rename the entry or restore the file.").toEqual([]);
  });
});
