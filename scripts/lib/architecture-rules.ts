/**
 * Package/application dependency rules for TulipFarm.
 *
 * This is the executable form of `docs/architecture/dependency-rules.md`. The
 * allowlist below is transcribed from that contract's tables; an omitted edge is
 * forbidden. `checkArchitecture` is a pure function over an import graph so it can
 * be unit-tested with fixtures and reused by the repo scanner in
 * `scripts/architecture-check.ts`.
 */

const CONTRACT_DOC = "docs/architecture/dependency-rules.md";

/** Import graph: node short-name (e.g. "soul") -> imported `@tulipfarm/*` short-names. */
export type ImportGraph = Record<string, string[]>;

export interface ArchitectureConfig {
  /** Governed node -> the `@tulipfarm/*` short-names it may import. Omitted edge = forbidden. */
  allowlist: Record<string, string[]>;
  /** Governed node -> legacy edges tolerated during cutover. Documented, reviewable, not blanket. */
  legacyExceptions: Record<string, string[]>;
}

export type Violation =
  | { kind: "forbidden-import"; from: string; to: string; message: string }
  | { kind: "cycle"; cycle: string[]; message: string };

const qualify = (shortName: string): string => `@tulipfarm/${shortName}`;

/**
 * Validate an import graph against the architecture contract.
 *
 * Two independent checks:
 *  1. Forbidden imports — every governed node may only import packages in its
 *     allowlist (plus documented legacy exceptions and itself). Ungoverned/legacy
 *     nodes are not policed for outgoing edges.
 *  2. Cycles — the full import graph (governed and legacy nodes alike) must be
 *     acyclic. Each distinct cycle is reported once.
 */
export function checkArchitecture(graph: ImportGraph, config: ArchitectureConfig): Violation[] {
  return [...findForbiddenImports(graph, config), ...findCycles(graph)];
}

function findForbiddenImports(graph: ImportGraph, config: ArchitectureConfig): Violation[] {
  const violations: Violation[] = [];
  for (const [from, imports] of Object.entries(graph)) {
    const allowed = config.allowlist[from];
    if (allowed === undefined) continue; // ungoverned/legacy node
    const permitted = new Set([from, ...allowed, ...(config.legacyExceptions[from] ?? [])]);
    for (const to of imports) {
      if (permitted.has(to)) continue;
      const allowedList = allowed.length > 0 ? allowed.map(qualify).join(", ") : "(none)";
      violations.push({
        kind: "forbidden-import",
        from,
        to,
        message:
          `${qualify(from)} imports ${qualify(to)}, which is not in its allowlist. ` +
          `Allowed: [${allowedList}]. See ${CONTRACT_DOC}.`,
      });
    }
  }
  return violations;
}

function findCycles(graph: ImportGraph): Violation[] {
  const violations: Violation[] = [];
  const seenCycles = new Set<string>();
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const next of graph[node] ?? []) {
      if (next === node) continue; // self-edges are handled by the forbidden-import check
      if (onStack.has(next)) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = canonicalCycleKey(cycle);
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          violations.push({
            kind: "cycle",
            cycle,
            message:
              `Import cycle detected: ${[...cycle, cycle[0]].map(qualify).join(" -> ")}. ` +
              `Break the cycle; see ${CONTRACT_DOC}.`,
          });
        }
      } else if (!visited.has(next)) {
        visit(next);
      }
    }
    onStack.delete(node);
    stack.pop();
  };

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) visit(node);
  }
  return violations;
}

/** Rotation-invariant key so the same cycle discovered from different entries dedupes. */
function canonicalCycleKey(cycle: string[]): string {
  const start = cycle.indexOf([...cycle].sort()[0]);
  return [...cycle.slice(start), ...cycle.slice(0, start)].join(">");
}

export function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return "Architecture check passed: no forbidden imports or cycles.";
  const lines = violations.map((v, i) => `  ${i + 1}. ${v.message}`);
  return `Architecture check found ${violations.length} violation(s):\n${lines.join("\n")}`;
}

/**
 * The real contract, transcribed from `docs/architecture/dependency-rules.md`.
 * Package rows come from the "Package import allowlist" table; app rows from the
 * "Application import allowlist" table.
 */
export const ARCHITECTURE_CONFIG: ArchitectureConfig = {
  allowlist: {
    // Foundations — no TulipFarm runtime package.
    schema: [],
    observability: [],
    // Storage/authz sit directly on the foundations.
    storage: ["schema", "observability"],
    authz: ["schema", "observability"],
    audit: ["schema", "storage", "observability"],
    soul: ["schema", "authz", "audit", "storage", "observability", "surface"],
    secrets: ["schema", "authz", "audit", "storage", "observability"],
    "run-kernel": ["schema", "audit", "storage", "observability"],
    sandbox: ["schema", "authz", "audit", "storage", "observability"],
    "tool-broker": ["schema", "authz", "audit", "secrets", "sandbox", "storage", "observability"],
    knowledge: ["schema", "authz", "audit", "storage", "observability"],
    memory: ["schema", "authz", "audit", "storage", "observability"],
    surface: ["schema"],
    "surface-web": ["surface", "ui"],
    "surface-slack": ["surface"],
    "surface-telegram": ["surface"],
    "surface-github": ["surface"],
    integrations: ["schema", "authz", "audit", "tool-broker", "storage", "observability"],
    "agent-runtime": [
      "schema",
      "authz",
      "audit",
      "run-kernel",
      "tool-broker",
      "knowledge",
      "memory",
      "observability",
    ],
    // Applications compose packages; they never import another application. `constants` holds the
    // shared, non-sensitive deployment defaults (e.g. the business scope) that the API and the
    // worker must agree on and cannot share any other way.
    api: [
      "schema",
      "soul",
      "constants",
      "authz",
      "audit",
      "secrets",
      "run-kernel",
      "tool-broker",
      // Both applications need one implementation of these or they need two copies: `sandbox` owns
      // the hook isolate the API spawns for resource hooks and the Worker spawns for ingress
      // classification, and `agent-runtime` owns system-prompt assembly, so the API's debug-context
      // route renders the prompt the Worker actually sent. Neither licenses running a turn here.
      "agent-runtime",
      "sandbox",
      "knowledge",
      "memory",
      "surface",
      "surface-web",
      "surface-slack",
      "surface-telegram",
      "surface-github",
      "integrations",
      "storage",
      "observability",
    ],
    worker: [
      "schema",
      "constants",
      "authz",
      "audit",
      "secrets",
      "run-kernel",
      "tool-broker",
      "agent-runtime",
      "knowledge",
      "memory",
      "surface",
      "integrations",
      "sandbox",
      "storage",
      "observability",
    ],
    "integration-worker": [
      "schema",
      "authz",
      "audit",
      "run-kernel",
      "tool-broker",
      "integrations",
      "storage",
      "observability",
    ],
    // `apps/web` uses shared wire schemas and presentation-only packages.
    web: ["schema", "surface", "surface-web", "ui", "editor"],
  },
  // Legacy v1 edges that still exist during cutover. Each is a target package
  // importing a not-yet-replaced legacy package; removed when its owner passes
  // replacement/cutover tests. New legacy edges must NOT be added here.
  legacyExceptions: {
    soul: ["constants"],
    api: ["llm", "routine-engine"],
    // The Worker executes the turn, so it is the process that calls a model. `@tulipfarm/llm` holds
    // the only provider/tier resolution there is, and the target home for it is `agent-runtime`
    // ("Model provider" in the extension-point table). Adding a second copy in the Worker would
    // create the same v1 debt twice over and then have to be unwound twice, so the edge is recorded
    // here instead: it retires when `agent-runtime` owns provider adapters, which drops the API's
    // identical edge in the same change.
    worker: ["llm"],
  },
};
