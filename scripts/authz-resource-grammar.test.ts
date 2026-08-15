import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_RESOURCES } from "../packages/authz/src/resources";

/**
 * Fitness function: the resource-name grammar in `docs/architecture/authorization-design.md` §4
 * and the closed namespaces in `packages/authz/src/resources.ts` say the same thing.
 *
 * The grammar is what a grant is written against. When the document and the code disagree, an
 * operator writes a grant for a resource the gate never asks about — which reads as a deny-by-
 * silence rather than as the misconfiguration it is. `platform.model` was missing from both for
 * the entire life of the model path, so "may this principal use this model" could not be asked.
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

const DOC = join(repoRoot(), "docs/architecture/authorization-design.md");

/** The `platform.*` row of the grammar table, as a set of backtick-quoted names. */
function documentedPlatformResources(): string[] {
  const doc = readFileSync(DOC, "utf8");
  const row = doc.split("\n").find((line) => line.startsWith("| `platform.*`"));
  if (row === undefined) throw new Error("no `platform.*` row in the resource grammar table");
  return [...row.matchAll(/`(platform\.[a-z_]+)`/g)].map((match) => match[1] ?? "");
}

describe("authorization resource grammar", () => {
  it("documents exactly the closed platform resources the code enumerates", () => {
    expect(documentedPlatformResources().sort()).toEqual([...PLATFORM_RESOURCES].sort());
  });

  it("includes the model resource, so a model call has something to be denied against", () => {
    expect(PLATFORM_RESOURCES).toContain("platform.model");
    expect(documentedPlatformResources()).toContain("platform.model");
  });

  it("keeps every platform resource two levels deep and exactly matchable", () => {
    // `grantMatches` does no prefix matching, so a three-level name would silently never match.
    for (const resource of PLATFORM_RESOURCES) {
      expect(resource.split(".")).toHaveLength(2);
    }
  });
});
