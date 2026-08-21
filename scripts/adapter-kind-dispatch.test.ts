import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for adapter-kind dispatch — the rule that a Tool reaches the backend its
 * contract declared, and no other.
 *
 * `ToolContractSpec.adapter.kind` shipped as decoration. `EffectDispatcher` resolved adapters by
 * `adapter.ref` alone, so a contract could declare one backend, name a ref registered to another,
 * and be handed that backend's authority; the declarative path made it concrete by constructing an
 * `OpenApiToolAdapter` for every compiled Tool whatever its kind said. The schema meanwhile
 * offered kinds no adapter served, so a manifest could bind to a backend that did not exist.
 *
 * This test fails the build when any of those three return: an adapter that does not declare its
 * kind, a dispatcher that does not compare the two, or a new kind with neither an implementation
 * nor an explicit reason to be declaration-only.
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

const SCANNED_ROOTS = ["apps", "packages"];
const SKIPPED = /\.test\.ts$|\.d\.ts$|node_modules|__fixtures__|\/test\/|\/dist\//;

const DISPATCH_FILE = "packages/tool-broker/src/effects/dispatch.ts";
const KINDS_FILE = "packages/schema/src/definitions/common.ts";
const DECLARATIVE_FILE = "apps/api/src/tools/declarative/tools.ts";

/**
 * Kinds a contract may declare that the effect plane deliberately does not serve, each with the
 * reason it is still valid. Adding a row is a decision to be argued in review, which is the point:
 * the failure this guards is a kind quietly appearing with nothing behind it.
 */
const DECLARATION_ONLY: Readonly<Record<string, string>> = {
  native: "served by the Tool host in packages/tool-host, which never reaches EffectDispatcher",
  mcp: "emitted by importMcpAsProposal for operator review; no adapter is registered yet",
};

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (SKIPPED.test(`${full}/`)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) found.push(full);
    }
  };
  for (const root of SCANNED_ROOTS) {
    const full = join(ROOT, root);
    if (existsSync(full)) walk(full);
  }
  return found;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Every declared kind, read from the schema rather than restated here. */
function declaredKinds(): string[] {
  const block = read(KINDS_FILE).match(/TOOL_ADAPTER_KINDS = \[([^\]]*)\]/s)?.[1];
  if (block === undefined) throw new Error("TOOL_ADAPTER_KINDS not found");
  return [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

/** Classes that implement the adapter contract, paired with the kind they declare. */
function adapterImplementations(): { file: string; className: string; kind?: string }[] {
  const found: { file: string; className: string; kind?: string }[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("ToolAdapter")) continue;
    for (const match of source.matchAll(
      /class\s+(\w+)\s+implements\s+([^{]*\bToolAdapter\b[^{]*)\{([\s\S]{0,400})/g
    )) {
      const kind = match[3].match(/readonly kind = "([a-z_]+)"/)?.[1];
      found.push({
        file: relative(ROOT, file),
        className: match[1],
        ...(kind === undefined ? {} : { kind }),
      });
    }
  }
  return found;
}

describe("adapter-kind dispatch", () => {
  it("finds the adapter implementations it is meant to be guarding", () => {
    // A scanner that silently matches nothing would pass every assertion below.
    const implementations = adapterImplementations();
    expect(implementations.length).toBeGreaterThanOrEqual(5);
    expect(implementations.map((entry) => entry.className)).toEqual(
      expect.arrayContaining([
        "OpenApiToolAdapter",
        "GitHubAdapter",
        "SlackToolAdapter",
        "SandboxToolAdapter",
      ])
    );
  });

  it("requires every ToolAdapter implementation to declare the backend it is", () => {
    const undeclared = adapterImplementations().filter((entry) => entry.kind === undefined);
    expect(
      undeclared,
      `these adapters do not declare a kind, so the dispatcher cannot tell what they are:\n${undeclared
        .map((entry) => `  ${entry.file} ${entry.className}`)
        .join("\n")}`
    ).toEqual([]);
  });

  it("requires every declared kind to be either implemented or explicitly declaration-only", () => {
    const implemented = new Set(
      adapterImplementations()
        .map((entry) => entry.kind)
        .filter((kind): kind is string => kind !== undefined)
    );
    const unserved = declaredKinds().filter(
      (kind) => !implemented.has(kind) && DECLARATION_ONLY[kind] === undefined
    );
    expect(
      unserved,
      `TOOL_ADAPTER_KINDS offers backends nothing serves: ${unserved.join(", ")}. ` +
        "Register an adapter, or add it to DECLARATION_ONLY with the reason it is still valid."
    ).toEqual([]);
  });

  it("keeps the declaration-only list honest: no entry may name a kind that is now served", () => {
    const implemented = new Set(
      adapterImplementations()
        .map((entry) => entry.kind)
        .filter((kind): kind is string => kind !== undefined)
    );
    const declared = new Set(declaredKinds());
    for (const kind of Object.keys(DECLARATION_ONLY)) {
      expect(declared.has(kind), `${kind} is exempted but no longer declared`).toBe(true);
      expect(implemented.has(kind), `${kind} is exempted but now has an adapter`).toBe(false);
    }
  });

  it("keeps the dispatcher comparing the declared kind against the resolved adapter", () => {
    const source = read(DISPATCH_FILE);
    expect(source).toContain("adapter.kind !== contract.adapter.kind");
    expect(source).toContain("adapter_kind_mismatch");

    // The comparison must precede the first attempt write, so a mis-registered contract leaves no
    // attempt claiming the call was routable.
    const mismatchAt = source.indexOf("adapter_kind_mismatch");
    const attemptAt = source.indexOf("beginAttempt");
    expect(mismatchAt).toBeGreaterThan(-1);
    expect(attemptAt).toBeGreaterThan(mismatchAt);
  });

  it("keeps the declarative composition root choosing its adapter by the declared kind", () => {
    const source = read(DECLARATIVE_FILE);
    expect(source).toContain("switch (tool.contract.spec.adapter.kind)");
    // An unserved kind must register nothing rather than fall back to a backend it did not declare.
    expect(source).toMatch(/default:\s*\n\s*return undefined;/);
  });
});
