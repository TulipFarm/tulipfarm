import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyseReachability, isTestSupportFile } from "./lib/reachability.ts";
import {
  DEBT_FILE,
  findingKey,
  loadDebt,
  methodKey,
  partitionFindings,
  serialiseDebt,
} from "./lib/reachability-debt.ts";

/**
 * "Who calls this in production?"
 *
 * The repo's most repeated defect is code that is written, exported and unit
 * tested but that no production code path reaches — twelve instances before
 * this control existed. The dependency-rule checker cannot see any of them: it
 * inspects the edges that exist, and this defect is the *absence* of an edge.
 *
 * `scripts/lib/reachability.ts` walks the module graph from the real
 * application entrypoints and classifies every exported value. This test pins
 * the result. An export nothing references at all fails outright. An export
 * only tests reach is held as a named, shrinking debt: entries may be removed,
 * never added, and an entry that has since been wired up fails too, so the
 * list cannot rot into decoration.
 */

const ROOT = repoRoot();

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

/** Build a throwaway repository so the engine can be tested on known shapes. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "reachability-"));
  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const APP_MANIFEST = JSON.stringify({
  name: "@tulipfarm/app",
  scripts: { dev: "tsx watch src/main.ts" },
});
const LIB_MANIFEST = JSON.stringify({ name: "@tulipfarm/lib", main: "src/index.ts" });

describe("the reachability engine", () => {
  it("finds an export that only a test reaches", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `import { used } from "@tulipfarm/lib";\nused();\n`,
      "packages/lib/package.json": LIB_MANIFEST,
      "packages/lib/src/index.ts": `export * from "./impl";\n`,
      "packages/lib/src/impl.ts": `export function used() {}\nexport class CircuitBreaker {}\n`,
      "packages/lib/src/impl.test.ts": `import { CircuitBreaker } from "./impl";\nnew CircuitBreaker();\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings.map(findingKey)).toEqual(["packages/lib/src/impl.ts#CircuitBreaker"]);
      expect(report.findings[0].reachability).toBe("test-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds an export nothing references at all", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `import { used } from "@tulipfarm/lib";\nused();\n`,
      "packages/lib/package.json": LIB_MANIFEST,
      "packages/lib/src/index.ts": `export * from "./impl";\n`,
      "packages/lib/src/impl.ts": `export function used() {}\nexport class Orphan {}\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings.map((f) => f.reachability)).toEqual(["unreferenced"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not accuse an export reached through a chain of barrels", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `import { deep } from "@tulipfarm/lib";\ndeep();\n`,
      "packages/lib/package.json": LIB_MANIFEST,
      "packages/lib/src/index.ts": `export * from "./nested";\n`,
      "packages/lib/src/nested/index.ts": `export { deep } from "./deep";\n`,
      "packages/lib/src/nested/deep.ts": `export function deep() {}\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings).toEqual([]);
      // The pass-through barrels are loaded, not dead.
      expect(report.deadModules).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a symbol used inside its own live module as reachable, not dead", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `import { entry } from "@tulipfarm/lib";\nentry();\n`,
      "packages/lib/package.json": LIB_MANIFEST,
      "packages/lib/src/index.ts": `export * from "./impl";\n`,
      "packages/lib/src/impl.ts": `export function helper() {}\nexport function entry() { helper(); }\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings).toEqual([]);
      expect(report.overExported.map((e) => e.name)).toEqual(["helper"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows tsconfig path aliases", () => {
    const dir = fixture({
      "apps/app/package.json": JSON.stringify({
        name: "@tulipfarm/app",
        scripts: { dev: "tsx watch src/main.ts" },
      }),
      "apps/app/tsconfig.json": `{\n  // the alias the app actually uses\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }\n}\n`,
      "apps/app/src/main.ts": `import { aliased } from "@/helper";\naliased();\n`,
      "apps/app/src/helper.ts": `export function aliased() {}\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a tsconfig whose path pattern contains a slash-star", () => {
    // `"@/*"` reads as the start of a block comment to a naive comment stripper,
    // which silently swallows the rest of the file and declares the app dead.
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "x/*": ["./src/*"] } } }`,
      "apps/app/src/main.ts": `import { aliased } from "@/helper";\naliased();\n`,
      "apps/app/src/helper.ts": `export function aliased() {}\n`,
    });
    try {
      expect(analyseReachability(dir).findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes entrypoints from package scripts, not from filenames", () => {
    // `src/index.ts` looks like an entrypoint and is really a test-only barrel.
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `console.log("up");\n`,
      "apps/app/src/index.ts": `export { thing } from "./thing";\n`,
      "apps/app/src/thing.ts": `export function thing() {}\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings.map(findingKey)).toEqual(["apps/app/src/thing.ts#thing"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not accuse a framework contract export", () => {
    const dir = fixture({
      "apps/web/package.json": JSON.stringify({
        name: "@tulipfarm/web",
        scripts: { dev: "remix vite:dev" },
      }),
      "apps/web/app/root.tsx": `export default function Root() { return null; }\n`,
      "apps/web/app/routes/index.tsx": `import { help } from "../lib/help";\nexport const loader = () => help();\nexport default function Page() { return null; }\n`,
      "apps/web/app/lib/help.ts": `export function help() {}\n`,
    });
    try {
      expect(analyseReachability(dir).findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts test support being reached only by tests, but not being dead", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `console.log("up");\n`,
      "packages/lib/package.json": LIB_MANIFEST,
      "packages/lib/src/index.ts": `export {};\n`,
      "packages/lib/src/test-doubles.ts": `export class FakeThing {}\nexport class NeverUsed {}\n`,
      "packages/lib/src/thing.test.ts": `import { FakeThing } from "./test-doubles";\nnew FakeThing();\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings.map(findingKey)).toEqual([
        "packages/lib/src/test-doubles.ts#NeverUsed",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The engine's first version reported the Resource-hook sandbox as dead: no
   * repo file imports a worker thread's entry module, because the runtime is
   * handed a path instead. That is the one error class a fitness function
   * cannot afford, since the honest response to a false accusation is to stop
   * believing the checker.
   */
  it("treats a worker thread's entry module as an entrypoint", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `import { spawn } from "./spawn";\nspawn();\n`,
      "apps/app/src/spawn.ts":
        `import { Worker } from "node:worker_threads";\n` +
        `export function spawn() {\n  return new Worker("./hook-worker.ts");\n}\n`,
      "apps/app/src/hook-worker.ts": `import { serve } from "@tulipfarm/lib";\nserve();\n`,
      "packages/lib/package.json": LIB_MANIFEST,
      "packages/lib/src/index.ts": `export { serve } from "./host";\n`,
      "packages/lib/src/host.ts": `export function serve() {}\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.findings.map(findingKey)).toEqual([]);
      expect(report.deadModules).not.toContain("apps/app/src/hook-worker.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The path is assembled by a helper, so literal and `new Worker` differ in file. */
  it("follows a worker path built by a resolver in another module", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `import { start } from "./start";\nstart();\n`,
      "apps/app/src/start.ts":
        `import { resolveHookWorkerPath, Host } from "@tulipfarm/lib";\n` +
        `export function start() {\n` +
        `  return new Host(resolveHookWorkerPath(__dirname, "hook-worker"));\n}\n`,
      "apps/app/src/hook-worker.ts": `import { serve } from "@tulipfarm/lib";\nserve();\n`,
      "packages/lib/package.json": LIB_MANIFEST,
      "packages/lib/src/index.ts": `export { serve } from "./host";\nexport { Host, resolveHookWorkerPath } from "./host";\n`,
      "packages/lib/src/host.ts":
        `import { Worker } from "node:worker_threads";\n` +
        `export function serve() {}\n` +
        `export function resolveHookWorkerPath(d: string, b: string) {\n  return \`\${d}/\${b}.ts\`;\n}\n` +
        `export class Host {\n  constructor(p: string) {\n    new Worker(p);\n  }\n}\n`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.deadModules).not.toContain("apps/app/src/hook-worker.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The rescue must be narrow: a bare string that happens to name a file is not a spawn. */
  it("does not resurrect a module merely because some string matches its name", () => {
    const dir = fixture({
      "apps/app/package.json": APP_MANIFEST,
      "apps/app/src/main.ts": `console.log("orphan");\n`,
      "apps/app/src/log.ts": `export function record(kind: string) {\n  return kind;\n}\n`,
      "apps/app/src/orphan.ts": `export function unused() {}\n`,
      "apps/app/src/uses-log.ts": `import { record } from "./log";\nrecord("orphan");\n`,
    });
    try {
      expect(analyseReachability(dir).deadModules).toContain("apps/app/src/orphan.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the debt list", () => {
  const report = analyseReachability(ROOT);
  const debt = loadDebt(ROOT);
  const partition = partitionFindings(report, debt);

  it("has a production entrypoint for every application", () => {
    for (const app of ["apps/api", "apps/web", "apps/worker", "apps/integration-worker"]) {
      expect(report.roots.some((root) => root.startsWith(`${app}/`))).toBe(true);
    }
  });

  it("accuses nothing that no line of the repository references", () => {
    expect(partition.unreferenced.map(findingKey)).toEqual([]);
  });

  it("records every remaining unreachable export", () => {
    expect(partition.introduced.map(findingKey)).toEqual([]);
  });

  it("holds no entry the tree no longer produces", () => {
    expect(partition.stale).toEqual([]);
  });

  it("states a reason for every justified exemption", () => {
    expect(partition.unexplained).toEqual([]);
  });

  it("records every public method no production module calls", () => {
    expect(partition.introducedMethods.map(methodKey)).toEqual([]);
  });

  it("holds no method entry that now has a production caller", () => {
    expect(partition.staleMethods).toEqual([]);
  });

  it("is byte-identical to what the current tree produces", () => {
    // `--update` must be a no-op on a clean tree, or the file has been
    // hand-edited into a shape the checker cannot reproduce.
    expect(serialiseDebt(report, debt)).toBe(
      `${JSON.stringify({ testOnly: [...debt.testOnly].sort(), justified: Object.fromEntries([...debt.justified].sort(([a], [b]) => a.localeCompare(b))), deadMethods: [...debt.deadMethods].sort() }, null, 2)}\n`
    );
  });
});

/**
 * A class is one export however many operations it carries, so the export
 * graph is blind to a method nobody calls — and several of the instances that
 * motivated this checker were exactly that: a cleanup or revocation method
 * built, tested, and never invoked.
 */
describe("method reachability", () => {
  const METHOD_FIXTURE = {
    "apps/app/package.json": APP_MANIFEST,
    "apps/app/src/main.ts": `import { Store } from "@tulipfarm/lib";
new Store().read();
`,
    "packages/lib/package.json": LIB_MANIFEST,
    "packages/lib/src/index.ts": `export { Store } from "./store";
`,
  };

  it("finds a public method no production module names", () => {
    const dir = fixture({
      ...METHOD_FIXTURE,
      "packages/lib/src/store.ts": `export class Store {
  read() {}
  deleteUnreferenced() {}
}
`,
      "packages/lib/src/store.test.ts": `import { Store } from "./store";
new Store().deleteUnreferenced();
`,
    });
    try {
      expect(analyseReachability(dir).deadMethods.map(methodKey)).toEqual([
        "packages/lib/src/store.ts#Store.deleteUnreferenced",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores private and protected members, which can have no outside caller", () => {
    const dir = fixture({
      ...METHOD_FIXTURE,
      "packages/lib/src/store.ts": `export class Store {
  read() {}
  private hide() {}
  protected shield() {}
}
`,
    });
    try {
      expect(analyseReachability(dir).deadMethods).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /* `JSON.stringify` reaches `toJSON`; demanding a named caller would be a false accusation. */
  it("ignores methods the language calls rather than repo code", () => {
    const dir = fixture({
      ...METHOD_FIXTURE,
      "packages/lib/src/store.ts": `export class Store {
  read() {}
  toJSON() {}
}
`,
    });
    try {
      expect(analyseReachability(dir).deadMethods).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /* An object literal satisfying a port names the method just as a call does. */
  it("counts a name supplied as an object-literal property as a caller", () => {
    const dir = fixture({
      ...METHOD_FIXTURE,
      "apps/app/src/main.ts":
        `import { Store } from "@tulipfarm/lib";
` +
        `const port = { deleteUnreferenced: () => {} };
` +
        `new Store().read();
port.deleteUnreferenced();
`,
      "packages/lib/src/store.ts": `export class Store {
  read() {}
  deleteUnreferenced() {}
}
`,
    });
    try {
      expect(analyseReachability(dir).deadMethods).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing about a class production never loads, which is already a dead module", () => {
    const dir = fixture({
      ...METHOD_FIXTURE,
      "packages/lib/src/index.ts": `export {};
`,
      "packages/lib/src/store.ts": `export class Store {
  read() {}
  sweep() {}
}
`,
      "apps/app/src/main.ts": `console.log("up");
`,
    });
    try {
      const report = analyseReachability(dir);
      expect(report.deadMethods).toEqual([]);
      expect(report.deadModules).toContain("packages/lib/src/store.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the ratchet fails in both directions", () => {
  const report = analyseReachability(ROOT);
  const debt = loadDebt(ROOT);

  it("fails when a recorded export becomes unreachable without being recorded", () => {
    const withoutOne = {
      testOnly: new Set([...debt.testOnly].slice(1)),
      justified: debt.justified,
      deadMethods: debt.deadMethods,
    };
    expect(partitionFindings(report, withoutOne).introduced.length).toBe(1);
  });

  it("fails when the list keeps an entry the tree no longer produces", () => {
    const withGhost = {
      testOnly: new Set([...debt.testOnly, "packages/lib/src/gone.ts#ghost"]),
      justified: debt.justified,
      deadMethods: debt.deadMethods,
    };
    expect(partitionFindings(report, withGhost).stale).toEqual(["packages/lib/src/gone.ts#ghost"]);
  });

  it("fails a justification that states no reason", () => {
    const key = [...debt.testOnly][0];
    const mute = {
      testOnly: debt.testOnly,
      justified: new Map([[key, "n/a"]]),
      deadMethods: debt.deadMethods,
    };
    expect(partitionFindings(report, mute).unexplained).toEqual([key]);
  });

  it("fails when a public method loses its last production caller", () => {
    const withoutOne = {
      testOnly: debt.testOnly,
      justified: debt.justified,
      deadMethods: new Set([...debt.deadMethods].slice(1)),
    };
    expect(partitionFindings(report, withoutOne).introducedMethods.length).toBe(1);
  });

  it("fails when the method list keeps an entry that now has a caller", () => {
    const withGhost = {
      testOnly: debt.testOnly,
      justified: debt.justified,
      deadMethods: new Set([...debt.deadMethods, "packages/lib/src/gone.ts#Ghost.sweep"]),
    };
    expect(partitionFindings(report, withGhost).staleMethods).toEqual([
      "packages/lib/src/gone.ts#Ghost.sweep",
    ]);
  });
});

describe("test-support classification", () => {
  it("names the directories and filenames that declare test intent", () => {
    expect(isTestSupportFile("packages/testkit/src/clock.ts")).toBe(true);
    expect(isTestSupportFile("packages/tool-host/src/test-doubles.ts")).toBe(true);
    expect(isTestSupportFile("packages/x/src/testing/harness.ts")).toBe(true);
    expect(isTestSupportFile("packages/x/src/service.ts")).toBe(false);
  });

  it("keeps the debt file where the checker looks for it", () => {
    expect(DEBT_FILE).toBe("scripts/reachability-debt.json");
  });
});
