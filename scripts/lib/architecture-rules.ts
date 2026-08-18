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
    storage: ["schema", "observability", "surface"],
    authz: ["schema", "observability"],
    audit: ["schema", "storage", "observability"],
    soul: ["schema", "authz", "audit", "storage", "observability", "surface"],
    secrets: ["schema", "authz", "audit", "storage", "observability"],
    "run-kernel": ["schema", "audit", "storage", "observability"],
    sandbox: ["schema", "authz", "audit", "storage", "observability"],
    "tool-broker": ["schema", "authz", "audit", "secrets", "sandbox", "storage", "observability"],
    knowledge: [
      "schema",
      "authz",
      "audit",
      "storage",
      "observability",
      "constants",
      "llm",
      "tool-host",
    ],
    memory: ["schema", "authz", "audit", "storage", "observability", "constants", "tool-host"],
    // Pure reasoning logic for the Curator: prompt assembly, output schema, citation validation,
    // document merge and Proposal mapping. It performs no IO, so it needs no store or authz port —
    // the API owns every effect it proposes.
    curator: ["schema", "constants", "observability"],
    // The Curator's server half: minting a job and its Run, pinning context, revalidating output
    // and recovering a crashed mint. Separate from `curator` because that package is pure and this
    // one must reach the gateway and the store; separate from `apps/api` because none of it is
    // Fastify. It holds no SQL of its own — every table it touches it reaches through `storage`.
    "curator-host": [
      "schema",
      "constants",
      "observability",
      "curator",
      "memory",
      "run-kernel",
      "storage",
    ],
    // The Tool execution host: the gate, the dispatcher and the Tool contract, so the control
    // plane and the durable runtime run one implementation rather than two that drift.
    "tool-host": [
      "schema",
      "authz",
      "soul",
      "run-kernel",
      "tool-broker",
      "surface",
      "storage",
      "observability",
    ],
    kv: ["schema", "storage", "tool-host"],
    "platform-tools": ["schema", "tool-host", "agent-runtime"],
    surface: ["schema"],
    "surface-web": ["surface"],
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
    // The File entity: what may be uploaded, what its bytes really are, and who may read them.
    // It owns its own table so the ordered upload pipeline — authorize, length, stream, sniff,
    // reject, write — stays in one place; `apps/api` only adapts it to Fastify.
    files: ["constants", "schema", "storage"],
    // Translation between the `ModelPort` contract and the Vercel AI SDK's prompt, tool and usage
    // shapes. Extracted from the Worker so the offline eval harness converts a request and reads a
    // result exactly as production does — a second copy would let the eval score a tool call the
    // product would never make. Pure functions only: no provider, no credential, no I/O.
    "model-adapter": ["schema", "agent-runtime", "llm"],
    // How one Chat Turn executes, extracted from the Worker so a second host — the offline eval
    // harness — can drive a real Turn without importing an app. It declares the ports it needs
    // (`RunExecutor`, `SpendSink`, `ModelCallReceiptSource`) rather than importing the Worker's
    // implementations of them.
    "turn-executor": ["schema", "run-kernel", "agent-runtime", "storage"],
    // Applications compose packages; they never import another application. `constants` holds the
    // shared, non-sensitive deployment defaults (e.g. the business scope) that the API and the
    // worker must agree on and cannot share any other way.
    api: [
      "schema",
      "soul",
      "constants",
      "files",
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
      "curator",
      "curator-host",
      "surface",
      "surface-web",
      "surface-slack",
      "surface-telegram",
      "surface-github",
      "integrations",
      "storage",
      "observability",
      "tool-host",
      "kv",
      "platform-tools",
    ],
    worker: [
      "schema",
      "constants",
      "authz",
      "audit",
      "secrets",
      "soul",
      "run-kernel",
      "tool-broker",
      "agent-runtime",
      "knowledge",
      "memory",
      "curator",
      "surface",
      "integrations",
      "sandbox",
      "storage",
      "observability",
      // The Worker hosts the co-locatable Tool families in process. `tool-host` is the single
      // dispatcher both processes run; the rest are the families whose members clear its
      // admission rule.
      "tool-host",
      "kv",
      "platform-tools",
      "turn-executor",
      "model-adapter",
    ],
    "integration-worker": [
      "schema",
      "authz",
      "audit",
      // Pool tuning has to be identical in every process that opens a connection: three apps
      // sizing their pools independently oversubscribe the server's `max_connections` between
      // them, and the failure shows up as an unrelated app being refused a connection.
      "constants",
      "run-kernel",
      "tool-broker",
      "integrations",
      "storage",
      "observability",
    ],
    // `apps/web` uses shared wire schemas and presentation-only packages.
    web: ["files", "schema", "surface", "surface-web", "editor"],
    // `apps/eval` drives the real Agent loop and Context assembler against a versioned Corpus.
    // It is an app, not a package, because a package may not import from `apps/*` and the L3
    // tier has to reach the same executor a real turn runs through.
    //
    // `llm` is an allowlisted edge here rather than a `legacyExceptions` entry, because it is not
    // the same debt the API and the Worker carry. Those two import it for *product* model
    // resolution, which is meant to move into `agent-runtime`. The eval imports it to build one
    // deliberately pinned model and to price the call, and `priceCall` is enforced as the single
    // authority on cost (`scripts/llm-pricing-authority.test.ts`) — so pricing an eval call any
    // other way is already forbidden. `schema` and `secrets` come with `createModel`'s signature:
    // a `ProviderEntry` to describe the model and a `SecretsService` to resolve its key. Building
    // the client any other way would diverge from production in the one layer the eval must hold
    // constant.
    //
    // `storage` and `run-kernel` are the L3 tier's edges. That tier runs a Turn through the real
    // `createChatExecutor`, which requires a real `RunStore`, `RunEventStore`, `BudgetStore` and
    // State machine. Substituting in-memory doubles would leave L3 measuring the eval's own
    // reimplementation of the Run lifecycle — the one thing L3 exists to prove L2 cannot.
    //
    // `tool-host` is the autonomy ceiling. A Case measuring whether an Agent's configured autonomy
    // still bounds its Tool loop has to ask production's own predicate; a copy here would go on
    // passing after the product's ceiling was loosened, which is the regression the Case exists
    // to catch.
    eval: [
      "agent-runtime",
      "turn-executor",
      "model-adapter",
      "llm",
      "schema",
      "secrets",
      "soul",
      "storage",
      "run-kernel",
      "tool-host",
    ],
  },
  // Legacy v1 edges that still exist during cutover. Each is a target package
  // importing a not-yet-replaced legacy package; removed when its owner passes
  // replacement/cutover tests. New legacy edges must NOT be added here.
  legacyExceptions: {
    soul: ["constants"],
    api: ["llm"],
    // The Worker executes the turn, so it is the process that calls a model. `@tulipfarm/llm` holds
    // the only provider/tier resolution there is, and the target home for it is `agent-runtime`
    // ("Model provider" in the extension-point table). Adding a second copy in the Worker would
    // create the same v1 debt twice over and then have to be unwound twice, so the edge is recorded
    // here instead: it retires when `agent-runtime` owns provider adapters, which drops the API's
    // identical edge in the same change.
    worker: ["llm"],
  },
};
