import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Barrels name what they export.
 *
 * `export * from "./x"` publishes whatever `x` happens to declare, so the public surface of a
 * package changes silently whenever an internal file gains an export. A caller cannot tell from
 * the import line what it is reaching into, and an internal helper — an adapter that performs an
 * effect, a primitive that enforces a policy — becomes reachable from anywhere without anyone
 * deciding it should be.
 *
 * Most packages already list their exports explicitly. This test pins that, and holds the
 * remainder as a named, shrinking debt rather than an open-ended habit.
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
const STAR_EXPORT = /^export \* from/gm;

/**
 * Packages whose barrel is still opaque, with the layer that owns the cleanup. The campaign is
 * bottom-up, so each package is de-starred when its own layer is hardened rather than in one
 * sweeping diff. Entries may be removed, never added.
 */
const STAR_EXPORT_DEBT: Readonly<Record<string, string>> = {
  "agent-runtime": "L4 — Agent runtime",
  observability: "X — cross-cutting",
  "run-kernel": "L3 — Durable execution",
  sandbox: "L6 — single re-export, folded into the sandbox backend work",
  schema: "X — cross-cutting",
  storage: "L7 — Source of truth",
  surface: "L1 — Surfaces",
};

function barrels(): { pkg: string; stars: number }[] {
  return readdirSync(join(ROOT, "packages"))
    .map((pkg) => ({ pkg, index: join(ROOT, "packages", pkg, "src", "index.ts") }))
    .filter((entry) => existsSync(entry.index))
    .map(({ pkg, index }) => ({
      pkg,
      stars: (readFileSync(index, "utf8").match(STAR_EXPORT) ?? []).length,
    }));
}

describe("package barrels name what they export", () => {
  const found = barrels();

  it("has no star export outside the recorded debt", () => {
    const undeclared = found
      .filter((entry) => entry.stars > 0 && !(entry.pkg in STAR_EXPORT_DEBT))
      .map((entry) => `${entry.pkg} (${entry.stars})`);

    expect(
      undeclared,
      "These barrels re-export with `export *`, so their public surface grows whenever an " +
        "internal file gains an export. List the exports explicitly, as the other packages do."
    ).toEqual([]);
  });

  it("keeps the debt list honest — a cleaned package must be removed from it", () => {
    const starCount = new Map(found.map((entry) => [entry.pkg, entry.stars]));
    const stale = Object.keys(STAR_EXPORT_DEBT).filter((pkg) => (starCount.get(pkg) ?? 0) === 0);

    expect(
      stale,
      "These packages no longer star-export. Delete them from STAR_EXPORT_DEBT so the list keeps " +
        "measuring what is left."
    ).toEqual([]);
  });

  it("keeps the effect plane explicit, because that is where effects leave the system", () => {
    for (const pkg of ["tool-broker", "integrations"]) {
      const entry = found.find((candidate) => candidate.pkg === pkg);
      expect(entry, `${pkg} barrel not found`).toBeDefined();
      expect(entry?.stars, `${pkg} must list its exports explicitly`).toBe(0);
    }
  });
});
