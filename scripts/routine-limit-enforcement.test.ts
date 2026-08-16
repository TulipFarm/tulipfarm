import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveModelProfileBudgetLimits } from "../packages/run-kernel/src/budgets";
import { compileRoutine } from "../packages/run-kernel/src/routine/compiler";
import { routineBudgetScopedLimits } from "../packages/run-kernel/src/routine/limit-enforcement";
import { resolveForeachItems } from "../packages/run-kernel/src/routine/states/foreach";
import { stepRepeat } from "../packages/run-kernel/src/routine/states/repeat";
import { nextDispatchSlots } from "../packages/run-kernel/src/routine/states/step";

/**
 * Fitness function for L3-7: an authored `limits` block must reach an enforcement surface.
 *
 * Every piece looked wired. `CompiledRoutine.limits` and `CompiledState.limits` were populated,
 * `resolveLimits` implemented narrowest-wins, `RunBudgetManager` held a durable ledger, and each
 * had passing unit tests. Nothing joined them: production read neither compiled field and
 * constructed no `ScopedLimits` at Routine or State scope, so an author could declare a cost
 * ceiling, pass validation, and receive no ceiling at all — a safety control that failed open.
 *
 * Unit tests on the pieces cannot catch that and did not. These assertions run the pieces
 * together, and read the composition where running it is not practical.
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
const WORKER_SRC = join(ROOT, "apps/worker/src");
const RUN_KERNEL_SRC = join(ROOT, "packages/run-kernel/src");
const EXECUTOR = join(WORKER_SRC, "routine/executor.ts");
const AGENT_PORT = join(WORKER_SRC, "routine/agent-port.ts");
const MODEL_BUDGET = join(WORKER_SRC, "model-budget.ts");

/** Every non-test `.ts` file under `directory`, read as `{ path, source }`. */
function productionSources(directory: string): readonly { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      out.push({ path: full, source: readFileSync(full, "utf8") });
  }
  return out;
}

const ceiling = {
  principalKind: "service",
  principalId: "limit-fitness",
  grants: [],
  maxRiskClass: "low",
} as const;

/** An authored Routine that fans out, loops, and calls an Agent — one State per bounded quantity. */
function authoredRoutine(limits: Record<string, number>, stateLimits?: Record<string, number>) {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "01J0000000000000000000LIMT",
      slug: "limit-fitness",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      owner: "platform",
      start: "Fan",
      limits,
      states: [
        {
          type: "foreach",
          name: "Fan",
          items: "input.items",
          body: "Unit",
          join: "all",
          transition: "Loop",
          ...(stateLimits === undefined ? {} : { limits: stateLimits }),
        },
        {
          type: "branch",
          name: "Unit",
          conditions: [{ condition: "true", end: true }],
          default: { end: true },
        },
        {
          type: "repeat_until",
          name: "Loop",
          condition: "false",
          body: "Tick",
          transition: "Ask",
        },
        {
          type: "branch",
          name: "Tick",
          conditions: [{ condition: "true", end: true }],
          default: { end: true },
        },
        {
          type: "agent",
          name: "Ask",
          agentRef: { name: "triage", version: "1.0.0" },
          end: true,
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: authored fixture, validated by the compiler.
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: authored fixture, validated by the compiler.
  } as any;
}

describe("authored Routine limits reach enforcement (L3-7)", () => {
  it("finds the compiled fields this test is meant to guard", () => {
    // If `limits` stops being compiled, everything below is vacuous — fail loud, not silently.
    const compiled = compileRoutine(authoredRoutine({ costUsd: 1, fanOut: 2 }), {
      identityCeiling: ceiling,
    });
    expect(compiled.limits).toEqual({ costMicros: 1_000_000, fanOut: 2 });
    expect(compiled.states.get("Fan")?.limits).toEqual({});
  });

  it("narrows a State's fan-out bound from the Routine's authored limit", () => {
    const compiled = compileRoutine(authoredRoutine({ fanOut: 2 }), { identityCeiling: ceiling });
    const fan = compiled.states.get("Fan");
    if (fan === undefined) throw new Error("Fan state missing");
    expect(fan.bounds.maxItems).toBe(2);
    // The processor that already enforced `bounds` now enforces the authored ceiling with it.
    expect(() => resolveForeachItems(fan, { input: { items: [1, 2, 3] } })).toThrow(
      "item_cap_exceeded:Fan"
    );
    expect(resolveForeachItems(fan, { input: { items: [1, 2] } })).toEqual([1, 2]);
  });

  it("lets a State limit narrow the Routine limit, never raise it", () => {
    const narrowed = compileRoutine(authoredRoutine({ fanOut: 5 }, { fanOut: 1 }), {
      identityCeiling: ceiling,
    });
    expect(narrowed.states.get("Fan")?.bounds.maxItems).toBe(1);

    const raised = compileRoutine(authoredRoutine({ fanOut: 1 }, { fanOut: 5 }), {
      identityCeiling: ceiling,
    });
    expect(raised.states.get("Fan")?.bounds.maxItems).toBe(1);
  });

  it("bounds parallelism, iterations and loop wall time from the authored limits", () => {
    const compiled = compileRoutine(
      authoredRoutine({ fanOut: 4, parallelism: 1, iterations: 1, wallClockMs: 1_000 }),
      { identityCeiling: ceiling }
    );
    const fan = compiled.states.get("Fan");
    const loop = compiled.states.get("Loop");
    if (fan === undefined || loop === undefined) throw new Error("fixture states missing");

    expect(nextDispatchSlots(fan, ["pending", "pending"]).indices).toEqual([0]);
    expect(() => stepRepeat(loop, { iterations: 1, startedAtMs: 0 }, {}, 0)).toThrow(
      "iteration_cap_exceeded:Loop"
    );
    expect(() => stepRepeat(loop, { iterations: 0, startedAtMs: 0 }, {}, 1_000)).toThrow(
      "duration_cap_exceeded:Loop"
    );
  });

  it("resolves the authored cost ceiling with the ModelProfile's own budgets, narrowest wins", () => {
    const compiled = compileRoutine(authoredRoutine({ costUsd: 1, tokens: 500 }), {
      identityCeiling: ceiling,
    });
    const scoped = routineBudgetScopedLimits(compiled);
    if (scoped === undefined) throw new Error("Routine budget scope missing");

    // Routine narrower than the profile on cost, profile narrower on tokens: one ceiling per key.
    const resolved = resolveModelProfileBudgetLimits(
      { budgets: { maxCostUsd: 10, maxTokens: 100 } },
      [scoped]
    );
    expect(resolved.costMicros).toEqual({ value: 1_000_000, scope: "routine" });
    expect(resolved.tokens).toEqual({ value: 100, scope: "model" });

    // An unbudgeted profile still gets the Routine's ceiling; before L3-7 it got none.
    expect(resolveModelProfileBudgetLimits({}, [scoped]).costMicros?.value).toBe(1_000_000);
  });

  it("has at least one production site constructing limits at Routine or State scope", () => {
    // This is the exact count that was zero when L3-7 was filed: every match was a `.test.ts`.
    const sites = [...productionSources(WORKER_SRC), ...productionSources(RUN_KERNEL_SRC)].filter(
      ({ source }) => /scope:\s*"(routine|state)"/.test(source)
    );
    expect(sites.length).toBeGreaterThan(0);
  });

  it("carries the Routine ceiling from the executor to the Run budget ledger", () => {
    // Executor reads the compiled Routine's limits and hands them to the Agent port…
    const executor = readFileSync(EXECUTOR, "utf8");
    expect(executor).toMatch(/routineBudgetScopedLimits\(this\.ctx\.routine\)/);
    expect(executor).toMatch(/scopedLimits:\s*\[scopedLimits\]/);

    // …the port forwards them into the single budget-open call it makes…
    const agentPort = readFileSync(AGENT_PORT, "utf8");
    expect(agentPort).toMatch(/scoped:\s*request\.scopedLimits\s*\?\?\s*\[\]/);

    // …and the open resolves them together with the profile, rather than opening a second ledger.
    const modelBudget = readFileSync(MODEL_BUDGET, "utf8");
    expect(modelBudget).toMatch(
      /resolveModelProfileBudgetLimits\(input\.profile,\s*input\.scoped\s*\?\?\s*\[\]\)/
    );
  });
});
