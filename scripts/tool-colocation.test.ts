import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { localDispatchRefusal } from "../packages/tool-host/src/eligibility";

/**
 * Fitness function for L3-1: Tools that execute inside the durable runtime.
 *
 * `apps/worker` hosts a subset of Tools in-process instead of calling the control plane for each
 * one. That is only safe while both processes authorize the *same* declaration, so this test
 * stands where neither process can: it reads both compositions as source and fails the build when
 * they drift. Two invariants:
 *
 *  1. Every locally hosted family comes from a shared package that `apps/api` registers too, so
 *     there is exactly one declaration and no second copy to edit one-sidedly.
 *  2. Registration is gated on `localDispatchRefusal`, so nothing is ever authorized in the worker
 *     against less evidence than the control plane would have had. Families are mixed — a family
 *     is hosted for its eligible members while the rest keep taking the control-plane hop — so
 *     the gate, not the family list, is what has to hold.
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
const LOCAL_HOST = join(ROOT, "apps/worker/src/tools/local-host.ts");

/** The `@tulipfarm/*` specifiers `local-host.ts` pulls Tool definitions from. */
function hostedFamilySources(source: string): readonly string[] {
  const hosted = source.slice(source.indexOf("function hostedFamilies("));
  const names = [...hosted.matchAll(/definitions: ([A-Z][A-Z0-9_]*_TOOLS)\b/g)];
  return [
    ...new Set(
      names.map((match) => {
        const importLine = new RegExp(
          `import\\s*\\{[^}]*\\b${match[1]}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`
        );
        const found = importLine.exec(source);
        if (found === null) throw new Error(`no import found for ${match[1]}`);
        return `${found[1]}#${match[1]}`;
      })
    ),
  ];
}

describe("tool co-location (L3-1)", () => {
  const localHost = readFileSync(LOCAL_HOST, "utf8");
  const families = hostedFamilySources(localHost);

  it("hosts at least one family, so the invariants below are not vacuously true", () => {
    expect(families.length).toBeGreaterThan(0);
  });

  it("hosts only families that live in a shared package", () => {
    for (const family of families) {
      expect(family.startsWith("@tulipfarm/")).toBe(true);
    }
  });

  it("hosts only families the control plane registers from the same package", () => {
    // The control plane may re-export a family through its own composition, so match on the
    // import anywhere in `apps/api/src` rather than only in the registration entry point.
    const apiSource = readSources(join(ROOT, "apps/api/src"));
    for (const family of families) {
      const [specifier, name] = family.split("#");
      const imported = apiSource.some((file) =>
        new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"${specifier}"`, "s").test(
          file
        )
      );
      expect(imported, `apps/api does not import ${name} from ${specifier}`).toBe(true);
    }
  });

  it("gates every registration on the eligibility rule", () => {
    // Asserted as source because the alternative is trusting the composition it guards.
    expect(localHost).toMatch(
      /if \(localDispatchRefusal\(tool\.definition\) !== undefined\) continue;/
    );
  });

  it("hosts a family only when the rule admits some of it", async () => {
    for (const family of families) {
      const [specifier, name] = family.split("#");
      const module = (await import(sourceEntryOf(specifier))) as Record<string, unknown>;
      const definitions = module[name] as readonly {
        name: string;
        // biome-ignore lint/suspicious/noExplicitAny: the eligibility rule is context-agnostic.
        definition?: any;
      }[];
      expect(definitions.length).toBeGreaterThan(0);
      const admitted = definitions.filter(
        (tool) => localDispatchRefusal(toDefinition(tool)) === undefined
      );
      expect(admitted.length, `${name} contributes no locally hostable Tool`).toBeGreaterThan(0);
    }
  });

  it("records which Tools are hosted, so a declaration change is visible in review", async () => {
    const admitted: string[] = [];
    for (const family of families) {
      const [specifier, name] = family.split("#");
      const module = (await import(sourceEntryOf(specifier))) as Record<string, unknown>;
      // biome-ignore lint/suspicious/noExplicitAny: the eligibility rule is context-agnostic.
      for (const tool of module[name] as readonly any[]) {
        if (localDispatchRefusal(toDefinition(tool)) === undefined) admitted.push(tool.name);
      }
    }
    expect(admitted.sort()).toEqual(
      [
        "cite_sources",
        "complete_state",
        "complete_task",
        "create_knowledge_page",
        "create_space",
        "get_backlinks",
        "get_current_time",
        "get_page",
        "get_page_by_path",
        "get_space_graph",
        "kv_delete",
        "kv_get",
        "kv_list",
        "kv_set",
        "list_spaces",
        "navigate_space",
        "update_memory",
        "validate_artifact",
        "write_page",
      ].sort()
    );
  });
});

/** Every `.ts` file under `directory`, read once. */
function readSources(directory: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...readSources(full));
    else if (entry.name.endsWith(".ts")) out.push(readFileSync(full, "utf8"));
  }
  return out;
}

/** Resolve a workspace specifier to its source entry; the root package does not depend on it. */
function sourceEntryOf(specifier: string): string {
  for (const manifest of readdirSync(join(ROOT, "packages"))) {
    const packageJson = join(ROOT, "packages", manifest, "package.json");
    if (!existsSync(packageJson)) continue;
    const { name } = JSON.parse(readFileSync(packageJson, "utf8")) as { name: string };
    if (name === specifier) return join(ROOT, "packages", manifest, "src/index.ts");
  }
  throw new Error(`no workspace package named ${specifier}`);
}

/** `ApiToolDefinition` already carries the declaration the gate reads; the wrapper adds no facts. */
// biome-ignore lint/suspicious/noExplicitAny: reading an arbitrary family's declaration by shape.
function toDefinition(tool: any): any {
  return tool.definition ?? tool;
}
