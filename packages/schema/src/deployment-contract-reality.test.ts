import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { type DeploymentContractEnvVar, parseDeploymentContract } from "./deployment-contract";

/**
 * The contract is only true if the code agrees with it.
 *
 * `deployment-contract.test.ts` proves `deploy/contract.yml` is well-formed. Well-formed is not the
 * same as true: a maintainer can document a variable nothing reads, or make the boot path depend on
 * a variable the contract never names. Either failure reaches an operator as a deployment that does
 * not work for reasons the documentation cannot explain. This test fails CI in both directions.
 *
 * What it can see, and what it cannot. There is no TypeScript parse here — a static text scan of
 * the five env-read idioms the repository actually uses:
 *
 *   1. `process.env.NAME` / `process.env["NAME"]`
 *   2. `env.NAME` / `env["NAME"]` on an injected `ProcessEnv` (e.g. `ports/blob-config.ts`)
 *   3. `helper(env, "NAME", default)` — env passed to a reader (e.g. `worker/src/config.ts`)
 *   4. `runtimeEnvironment.NAME` — a captured environment whose variable name contains `env`
 *      (e.g. `integrations/src/auth/public-origins.ts`)
 *   5. `import.meta.env.VITE_*` — Vite client variables in `apps/web`
 *
 * Idioms 2–4 are unified by matching a property/index/call on any identifier that contains `env`.
 * Two things this deliberately cannot distinguish, both stated so the check does not lie about its
 * reach: a *reader* named `envInt(...)` from a *writer* named `environmentLine(...)` — both are
 * env-ish calls — and a real `process.env` from a per-integration object also called `env`. Those
 * false positives are handled by named exclusions below, never by a silent filter.
 *
 * The two directions are deliberately asymmetric:
 *
 * - **Contract → code** is generous. A variable counts as read if its name appears as any token in
 *   non-test source. It has to be: `apps/api/src/env.ts` reads its secrets through `env[name]` over
 *   a list of string-literal names, a dynamic lookup no static idiom can see. Generosity here is the
 *   safe direction — it refuses to demand the deletion of a variable that is in fact read.
 * - **Code → contract** is strict. Only a recognized env-read idiom counts, because this direction
 *   accuses the contract of an omission and must be sure before it does.
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
const SOURCE_ROOTS = ["apps", "packages"];
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  ".source",
  ".react-router",
  ".vitest-reports",
  ".claude",
  ".worktrees",
]);

/** Consumers that a TypeScript process reads; the rest read shell, not code. */
const TS_CONSUMERS = new Set(["app", "web", "worker", "integration-worker"]);

/**
 * Names a recognized env-read idiom surfaces that are deliberately absent from the contract. Each
 * carries the reason it is not a deployment variable. `keeps no exclusion the code no longer
 * produces` fails if any entry stops being read, so this list can only shrink — it can never rot
 * into a way to silence a real omission.
 */
const REVERSE_EXCLUSIONS: Readonly<Record<string, string>> = {
  DEV: "Vite injects `import.meta.env.DEV`; a build-time client flag, not a deployment variable.",
  PATH: "The operating system's process PATH, forwarded to spawned git; never a TulipFarm knob.",
  HTTP_PROXY:
    "A standard outbound-proxy variable the sandbox writes into the container it launches, not read here.",
  HTTPS_PROXY:
    "A standard outbound-proxy variable the sandbox writes into the container it launches, not read here.",
  TULIP_INPUT_DIR:
    "A sandbox mount path written into the launched container, read inside it, never by a service.",
  TULIP_OUTPUT_DIR:
    "A sandbox mount path written into the launched container, read inside it, never by a service.",
  SLACK_BOT_TOKEN:
    "An Integration connection secret read from a connection.yaml `env` block, not from process.env.",
  TF_CODEX_BIN:
    "A developer-only override for the local Codex CLI binary; never set in a deployment.",
};

/**
 * Read but only ever by tests, so deliberately out of the contract. Held apart from
 * REVERSE_EXCLUSIONS because the non-test scan never surfaces it; a separate test pins that fact so
 * the exemption stays honest rather than silent.
 */
const TEST_ONLY_VARIABLE = "TULIPFARM_SKILLS_DIR";

const NAME = "[A-Z][A-Z0-9_]{2,}";
const ENVISH = "\\b[A-Za-z0-9_$]*[Ee]nv[A-Za-z0-9_$]*";
const STRICT_IDIOMS = [
  new RegExp(`${ENVISH}\\.(${NAME})`, "g"),
  new RegExp(`${ENVISH}\\[["'\`](${NAME})["'\`]\\]`, "g"),
  new RegExp(`${ENVISH}\\s*[(,]\\s*["'\`](${NAME})["'\`]`, "g"),
  /import\.meta\.env\.(VITE_[A-Z0-9_]*)/g,
];
const TOKEN = new RegExp(`\\b${NAME}\\b`, "g");

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface Scan {
  /** Every SCREAMING_SNAKE token in non-test source — the generous contract → code surface. */
  readonly tokens: ReadonlySet<string>;
  /** Env-read idiom hits, name → the sorted files that read it — the strict code → contract surface. */
  readonly strictReads: ReadonlyMap<string, readonly string[]>;
}

function scanSources(): Scan {
  const files = SOURCE_ROOTS.flatMap((base) => sourceFiles(join(ROOT, base)));
  const tokens = new Set<string>();
  const strict = new Map<string, Set<string>>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const rel = relative(ROOT, file).split(sep).join("/");
    for (const match of source.matchAll(TOKEN)) tokens.add(match[0]);
    for (const idiom of STRICT_IDIOMS) {
      idiom.lastIndex = 0;
      for (const match of source.matchAll(idiom)) {
        const name = match[1];
        if (!strict.has(name)) strict.set(name, new Set());
        strict.get(name)?.add(rel);
      }
    }
  }
  const strictReads = new Map<string, readonly string[]>();
  for (const [name, seen] of strict) strictReads.set(name, [...seen].sort());
  return { tokens, strictReads };
}

function installerText(): string {
  const dir = join(ROOT, "scripts");
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".sh"))
    .map((entry) => readFileSync(join(dir, entry), "utf8"))
    .join("\n");
}

/** Every surface a variable's declared consumers say should reference it, and whether each does. */
function unreferencedSurfaces(
  variable: DeploymentContractEnvVar,
  scan: Scan,
  compose: string,
  installer: string
): string[] {
  const drifted: string[] = [];
  const hasTs = variable.consumers.some((consumer) => TS_CONSUMERS.has(consumer));
  if (hasTs && !scan.tokens.has(variable.name)) drifted.push("no application or package source");
  if (variable.consumers.includes("compose") && !compose.includes(variable.name)) {
    drifted.push("docker-compose.yml");
  }
  if (variable.consumers.includes("installer") && !installer.includes(variable.name)) {
    drifted.push("no installer script under scripts/");
  }
  return drifted;
}

describe("deploy/contract.yml agrees with the code that reads the environment", () => {
  const contract = parseDeploymentContract(
    readFileSync(join(ROOT, "deploy", "contract.yml"), "utf8")
  );
  const scan = scanSources();
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const installer = installerText();
  const contractNames = new Set(contract.env.map((variable) => variable.name));

  it("names no variable that nothing reads (contract → code)", () => {
    const drift = contract.env.flatMap((variable) =>
      unreferencedSurfaces(variable, scan, compose, installer).map(
        (surface) =>
          `${variable.name} is named in the contract (consumers ${variable.consumers.join(
            ", "
          )}) but ${surface} reads it — contract → code drift`
      )
    );
    expect(drift).toEqual([]);
  });

  it("omits no variable the boot path or blob configuration reads (code → contract)", () => {
    const drift = [...scan.strictReads]
      .filter(
        ([name]) =>
          !contractNames.has(name) && !(name in REVERSE_EXCLUSIONS) && name !== TEST_ONLY_VARIABLE
      )
      .map(
        ([name, files]) =>
          `${name} is read by ${files[0]} but the contract omits it — code → contract drift`
      )
      .sort();
    expect(drift).toEqual([]);
  });

  it("compares a real environment surface, so it cannot pass vacuously", () => {
    // Both sides must hold enough variables that an empty scan or an empty contract fails loudly
    // rather than agreeing by having nothing to disagree about.
    expect(contract.env.length).toBeGreaterThan(50);
    expect(scan.strictReads.size).toBeGreaterThan(30);
    expect(compose.length).toBeGreaterThan(0);
    expect(installer.length).toBeGreaterThan(0);
  });

  it("still checks deliberately-internal variables rather than exempting them", () => {
    // A `never-set` zone means "internal plumbing", not "skip the reality check". Prove the forward
    // comparison actually reaches such variables, so nobody can hide an unread one behind the zone.
    const internal = contract.env.filter(
      (variable) =>
        variable.zone === "never-set" && variable.consumers.some((c) => TS_CONSUMERS.has(c))
    );
    expect(internal.length).toBeGreaterThan(0);
    const unread = internal
      .filter((variable) => !scan.tokens.has(variable.name))
      .map((variable) => variable.name);
    expect(unread).toEqual([]);
  });

  it("keeps no exclusion the code no longer produces", () => {
    // A reverse exclusion exists only to silence a name the strict scan really reads. Once the code
    // stops reading it, the entry is decoration — this fails until it is deleted, the same ratchet
    // shape as scripts/reachability.test.ts.
    const stale = Object.keys(REVERSE_EXCLUSIONS).filter((name) => !scan.strictReads.has(name));
    expect(stale, "these excluded names are no longer read — delete their entries").toEqual([]);
  });

  it("keeps no reverse exclusion that is actually in the contract", () => {
    const contradicted = Object.keys(REVERSE_EXCLUSIONS).filter((name) => contractNames.has(name));
    expect(contradicted, "these are documented after all — drop the exclusion").toEqual([]);
  });

  it("documents the test-only variable that is deliberately out of contract", () => {
    // TULIPFARM_SKILLS_DIR is a test fixture knob, not a runtime one, so it is absent from the
    // contract on purpose. Pin that it is read only by tests, so the absence stays a decision.
    expect(contractNames.has(TEST_ONLY_VARIABLE)).toBe(false);
    expect(scan.strictReads.has(TEST_ONLY_VARIABLE)).toBe(false);
  });
});
