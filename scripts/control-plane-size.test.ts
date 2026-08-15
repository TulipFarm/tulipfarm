import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The control plane may shrink. It may not grow.
 *
 * `apps/api` holds roughly as much code as all 24 packages combined, and the finding that named it
 * observed the same thing three editions running: 50,693 → 54,379 → 62,239. Every hardening wave
 * added to the application instead of pushing logic into the package that nominally owns it. The
 * inversion was never one bad decision; it was the absence of anything that noticed.
 *
 * Since this file was added the ceiling has come down three times, by moving domain logic to its
 * owning package rather than by reclassifying it: 59,706 → 58,948 (memory) → 54,529 (knowledge,
 * soul, and the shared SQL helpers that had kept the repositories stranded in the app) → 48,718
 * (the soul slice, landed alongside an independent wave that moved knowledge and the Tool host).
 * The mark is 49,214 rather than 48,718 because a foundation-model campaign added 496 lines to the
 * control plane between the measurement and this landing — the first growth the ratchet has caught.
 *
 * Raised again to 50,074 for the Task system: `tasks/routes.ts` is Fastify and belongs here, and
 * `tasks/tools.ts` follows the same handwritten-Tool exception as `tools/github/` and
 * `tools/slack/` — there is no owning package for bespoke, non-manifest platform Tools to move to.
 *
 * `apps/api` no longer holds the majority: the packages now carry 73,822 lines to its 49,214.
 *
 * This is that. The ceiling is a high-water mark, not a target — lowering it as code moves out is
 * the point, and the only edit this file should ever receive. Raising it needs a reviewed reason,
 * because "the number went up again" is exactly the event three editions failed to catch.
 *
 * Line count is a crude proxy for ownership, deliberately. A precise measure would need to model
 * what each domain ought to own, which is the argument the refactor itself has to settle; a crude
 * measure that cannot be gamed without noticing is worth more here than a subtle one.
 */

const CEILING = 50_074;

/**
 * Domains inside `apps/api/src` that already have a package of the same name. Everything here that
 * does not touch Fastify is a candidate to move down; the counts are printed on failure so the next
 * person can see where the weight actually is rather than guessing.
 */
const DOMAINS_WITH_OWNING_PACKAGE = [
  "authz",
  "integrations",
  "knowledge",
  "memory",
  "soul",
] as const;

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

function sourceLines(absoluteDirectory: string): number {
  if (!existsSync(absoluteDirectory)) return 0;
  let total = 0;
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const full = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      total += sourceLines(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const source = readFileSync(full, "utf8");
    const lines = source.split("\n");
    total += lines.at(-1) === "" ? lines.length - 1 : lines.length;
  }
  return total;
}

describe("the control plane may shrink, not grow", () => {
  it("keeps apps/api/src at or below its high-water mark", () => {
    const actual = sourceLines(join(ROOT, "apps/api/src"));

    const breakdown = DOMAINS_WITH_OWNING_PACKAGE.map((domain) => {
      const inApp = sourceLines(join(ROOT, "apps/api/src", domain));
      const inPackage = sourceLines(join(ROOT, "packages", domain, "src"));
      return `  ${domain.padEnd(14)} apps/api ${String(inApp).padStart(6)}   packages ${inPackage}`;
    }).join("\n");

    expect(
      actual,
      `apps/api/src is ${actual} lines, over its ${CEILING} ceiling by ${actual - CEILING}.\n\n` +
        "Put the new logic in the package that owns the domain, or move something out and lower\n" +
        "the ceiling in this file. Domains that already have an owning package:\n\n" +
        `${breakdown}\n\n` +
        "Only code that touches Fastify has to live in apps/api."
    ).toBeLessThanOrEqual(CEILING);
  });

  it("states a ceiling that is still meaningful", () => {
    const actual = sourceLines(join(ROOT, "apps/api/src"));
    expect(
      CEILING - actual,
      `The ceiling is ${CEILING - actual} lines above actual (${actual}). Lower CEILING to ${actual} ` +
        "so the slack cannot be spent without review."
    ).toBeLessThanOrEqual(2_000);
  });
});
