import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for the mutation kill switch — the emergency stop over mutating Tool effects.
 *
 * The guard shipped inert: `MutationKillSwitchGuard` existed and was unit-tested, but nothing in
 * production ever constructed one, and `EffectDispatcher` only consults the guard when it is
 * given one. A control that is present, tested, and not installed is worse than an absent one,
 * because it reads as covered. This test fails the build when that state returns.
 *
 * It also pins the subtler failure: a switch scoped on a `MutationContext` field the dispatcher
 * never populates is accepted, stored, displayed as live, and stops nothing.
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

const SCANNED_ROOTS = ["apps/api/src", "apps/worker/src", "apps/integration-worker/src"];
const SKIPPED = /\.test\.ts$|\.d\.ts$|__fixtures__|\/test\//;

const DISPATCH_FILE = "packages/tool-broker/src/effects/dispatch.ts";
const SERVICE_FILE = "apps/api/src/kill-switches/service.ts";

/** Which `MutationContext` field each scope kind matches on, per `matches()` in resilience.ts. */
const SCOPE_FIELD: Readonly<Record<string, string>> = {
  agent: "agentId",
  routine: "routineId",
  tool: "toolId",
  provider: "provider",
  integration: "integrationId",
  destination: "destination",
  model: "model",
  data_class: "dataClasses",
  all_mutations: "mutation",
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

let cached: { file: string; text: string }[] | undefined;
function sources(): { file: string; text: string }[] {
  if (!cached) {
    cached = SCANNED_ROOTS.flatMap((root) => {
      const full = join(ROOT, root);
      return existsSync(full) ? walk(full) : [];
    }).map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, "utf8") }));
  }
  return cached;
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** The bracketed literal that follows `markerIndex`, matched by depth so nesting is not truncated. */
function bracketedAfter(text: string, markerIndex: number, open: "{" | "["): string {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open, markerIndex);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function literalAfter(text: string, markerIndex: number): string {
  return bracketedAfter(text, markerIndex, "{");
}

function allLiteralsAfter(text: string, marker: string | RegExp): string[] {
  const out: string[] = [];
  const pattern = typeof marker === "string" ? new RegExp(escapeRegExp(marker), "g") : marker;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined) out.push(literalAfter(text, match.index));
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("mutation kill switch is installed, not merely present", () => {
  it("passes a guard at every production EffectDispatcher", () => {
    const uninstalled: string[] = [];
    for (const { file, text } of sources()) {
      for (const construction of allLiteralsAfter(text, "new EffectDispatcher(")) {
        if (!construction.includes("mutationGuard")) uninstalled.push(file);
      }
    }
    expect(
      uninstalled,
      "every production EffectDispatcher must be given a mutationGuard, or the emergency stop " +
        "silently does not cover the effects it dispatches"
    ).toEqual([]);
  });

  it("constructs the guard in both processes that dispatch effects", () => {
    const constructing = sources()
      .filter(({ text }) => text.includes("new MutationKillSwitchGuard("))
      .map(({ file }) => file);

    expect(constructing).toContain("apps/api/src/index.ts");
    expect(constructing).toContain("apps/worker/src/main.ts");
  });

  it("keeps the guard consulted before any attempt is recorded", () => {
    const dispatch = read(DISPATCH_FILE);
    const guardAt = dispatch.indexOf("mutationGuard.assertAllowed");
    const attemptAt = dispatch.indexOf("store.beginAttempt");
    expect(guardAt).toBeGreaterThan(-1);
    expect(attemptAt).toBeGreaterThan(-1);
    expect(
      guardAt,
      "a denied mutation must not leave an attempt in the effect ledger"
    ).toBeLessThan(attemptAt);
  });

  it("offers operators only scopes the dispatcher actually populates", () => {
    const dispatch = read(DISPATCH_FILE);
    const contextIndex = dispatch.indexOf("mutationGuard.assertAllowed");
    const populated = new Set(
      [...literalAfter(dispatch, contextIndex).matchAll(/^\s*(\w+)[,:]/gm)].map(
        (match) => match[1] as string
      )
    );
    for (const identity of allLiteralsAfter(
      sources()
        .map(({ text }) => text)
        .join("\n"),
      /mutationIdentity\s*:/g
    )) {
      for (const match of identity.matchAll(/(\w+)\s*:/g)) populated.add(match[1] as string);
    }

    const declared = read(SERVICE_FILE);
    const assignment = declared.indexOf("=", declared.indexOf("ENFORCEABLE_SCOPE_KINDS:"));
    const enforceable = [...bracketedAfter(declared, assignment, "[").matchAll(/"(\w+)"/g)].map(
      (match) => match[1] as string
    );

    expect(enforceable.length, "could not read ENFORCEABLE_SCOPE_KINDS").toBeGreaterThan(0);
    const inert = enforceable.filter((kind) => !populated.has(SCOPE_FIELD[kind] as string));
    expect(
      inert,
      "these scope kinds are offered to operators but match on a MutationContext field the " +
        "dispatcher never fills, so a switch using them would stop nothing"
    ).toEqual([]);
  });

  it("keeps the denial reason on the dispatch error", () => {
    const dispatch = read(DISPATCH_FILE);
    expect(
      dispatch.includes("KillSwitchDeniedError"),
      "the dispatcher must surface which switch denied the effect, not a bare kill_switch_denied"
    ).toBe(true);
  });
});
