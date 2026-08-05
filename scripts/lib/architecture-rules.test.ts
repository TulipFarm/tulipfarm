import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_CONFIG,
  type ArchitectureConfig,
  checkArchitecture,
  formatViolations,
} from "./architecture-rules.ts";

const config: ArchitectureConfig = {
  allowlist: {
    schema: [],
    observability: [],
    storage: ["schema", "observability"],
    soul: ["schema", "storage"],
  },
  legacyExceptions: {
    soul: ["constants"],
  },
};

describe("checkArchitecture — forbidden imports", () => {
  it("allows a governed node importing an allowlisted package", () => {
    expect(checkArchitecture({ storage: ["schema", "observability"] }, config)).toEqual([]);
  });

  it("flags a governed node importing a package outside its allowlist", () => {
    const violations = checkArchitecture({ storage: ["soul"] }, config);
    expect(violations).toHaveLength(1);
    const [v] = violations;
    expect(v.kind).toBe("forbidden-import");
    expect(v).toMatchObject({ from: "storage", to: "soul" });
    // Actionable: names the offending edge, the allowlist, and the contract doc.
    expect(v.message).toContain("@tulipfarm/storage");
    expect(v.message).toContain("@tulipfarm/soul");
    expect(v.message).toContain("allowlist");
    expect(v.message).toContain("docs/architecture/dependency-rules.md");
  });

  it("tolerates a documented legacy exception", () => {
    expect(checkArchitecture({ soul: ["schema", "constants"] }, config)).toEqual([]);
  });

  it("ignores self imports", () => {
    expect(checkArchitecture({ soul: ["soul", "schema"] }, config)).toEqual([]);
  });

  it("does not police ungoverned nodes", () => {
    // `llm` has no allowlist entry -> it is legacy/ungoverned and is not checked.
    expect(checkArchitecture({ llm: ["schema", "soul", "storage"] }, config)).toEqual([]);
  });

  it("treats a foundation node (empty allowlist) as importing nothing", () => {
    const violations = checkArchitecture({ schema: ["storage"] }, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "forbidden-import",
      from: "schema",
      to: "storage",
    });
  });
});

describe("checkArchitecture — cycles", () => {
  it("detects a direct cycle", () => {
    const violations = checkArchitecture({ a: ["b"], b: ["a"] }, config);
    const cycles = violations.filter((v) => v.kind === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0].message).toContain("cycle");
    expect(cycles[0].message).toContain("docs/architecture/dependency-rules.md");
  });

  it("detects an indirect cycle", () => {
    const cycles = checkArchitecture({ a: ["b"], b: ["c"], c: ["a"] }, config).filter(
      (v) => v.kind === "cycle"
    );
    expect(cycles).toHaveLength(1);
    if (cycles[0].kind === "cycle") {
      expect(new Set(cycles[0].cycle)).toEqual(new Set(["a", "b", "c"]));
    }
  });

  it("reports each cycle only once", () => {
    const cycles = checkArchitecture({ a: ["b"], b: ["a"] }, config).filter(
      (v) => v.kind === "cycle"
    );
    expect(cycles).toHaveLength(1);
  });

  it("passes a DAG", () => {
    const cycles = checkArchitecture(
      { soul: ["schema", "storage"], storage: ["schema"], schema: [] },
      config
    ).filter((v) => v.kind === "cycle");
    expect(cycles).toEqual([]);
  });
});

describe("formatViolations", () => {
  it("renders every violation message", () => {
    const violations = checkArchitecture({ storage: ["soul"], a: ["b"], b: ["a"] }, config);
    const text = formatViolations(violations);
    for (const v of violations) expect(text).toContain(v.message);
  });

  it("returns a clean-tree message when there are no violations", () => {
    expect(formatViolations([]).toLowerCase()).toContain("no");
  });
});

describe("ARCHITECTURE_CONFIG", () => {
  it("governs all 16 target packages and 4 apps", () => {
    const governed = Object.keys(ARCHITECTURE_CONFIG.allowlist);
    for (const pkg of [
      "schema",
      "observability",
      "storage",
      "authz",
      "audit",
      "soul",
      "secrets",
      "run-kernel",
      "sandbox",
      "tool-broker",
      "knowledge",
      "memory",
      "surface",
      "integrations",
      "agent-runtime",
      "evals",
    ]) {
      expect(governed).toContain(pkg);
    }
    for (const app of ["api", "worker", "integration-worker", "web"]) {
      expect(governed).toContain(app);
    }
  });

  it("keeps foundation packages import-free", () => {
    expect(ARCHITECTURE_CONFIG.allowlist.schema).toEqual([]);
    expect(ARCHITECTURE_CONFIG.allowlist.observability).toEqual([]);
  });

  it("encodes the soul allowlist from the contract", () => {
    expect(new Set(ARCHITECTURE_CONFIG.allowlist.soul)).toEqual(
      new Set(["schema", "authz", "audit", "storage", "observability", "surface"])
    );
  });

  it("documents the current legacy exceptions", () => {
    expect(ARCHITECTURE_CONFIG.legacyExceptions.soul).toContain("constants");
    expect(new Set(ARCHITECTURE_CONFIG.legacyExceptions.api)).toEqual(
      new Set(["llm", "routine-engine"])
    );
  });

  it("never lists a package in both its allowlist and its legacy exceptions", () => {
    for (const [node, allowed] of Object.entries(ARCHITECTURE_CONFIG.allowlist)) {
      const legacy = ARCHITECTURE_CONFIG.legacyExceptions[node] ?? [];
      for (const dep of legacy) expect(allowed).not.toContain(dep);
    }
  });

  it("passes its own real config against itself with no cycles", () => {
    // The allowlist edges must themselves form a DAG.
    const graph: Record<string, string[]> = {};
    for (const [node, allowed] of Object.entries(ARCHITECTURE_CONFIG.allowlist)) {
      graph[node] = allowed;
    }
    const cycles = checkArchitecture(graph, ARCHITECTURE_CONFIG).filter((v) => v.kind === "cycle");
    expect(cycles).toEqual([]);
  });
});
