import { readFileSync } from "node:fs";
import { compileRoutine } from "@tulipfarm/run-kernel";
import { definitions } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { RESOURCE_TOOLS } from "../resources/tools.js";
import { NETWORK_TOOLS } from "../tools/network/tools.js";

/**
 * Every Routine the `routine-forge` Skill shows must be one the Worker would actually run.
 *
 * Schema validation alone is not enough, and the gap is not theoretical: the shipped examples
 * once taught `condition: "${states.X.output.y} == true"`, which is schema-valid and fails to
 * compile, because `condition` and `items` are bare expressions rather than `${ }` templates.
 * An authoring Agent copies what the Skill shows, so a broken example is a broken Routine.
 */

/** Mirrors `SUPPORTED_TYPES` in apps/worker/src/routine/execution-support.ts — keep both in step. */
const WORKER_EXECUTES: ReadonlySet<string> = new Set([
  "action",
  "agent",
  "approval",
  "branch",
  "child_routine",
  "compute",
  "emit",
  "foreach",
  "parallel",
  "repeat_until",
  "script",
  "tool",
  "wait",
]);

const SKILL_ROOT = `${__dirname}/../../../../skills/forge/routine-forge`;

type InputSchema = {
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly additionalProperties?: boolean;
};

/** The Tools' own declarations, so the examples are checked against the real contract. */
const TOOL_INPUT_SCHEMAS = new Map<string, InputSchema>(
  [...RESOURCE_TOOLS, ...NETWORK_TOOLS].map((tool) => [tool.name, tool.inputSchema as InputSchema])
);

const examples = [
  `${SKILL_ROOT}/SKILL.md`,
  `${SKILL_ROOT}/references/canonical-examples.md`,
].flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => parseYaml(match[1] as string) as Record<string, unknown>)
    .filter((document) => document?.kind === "Routine")
);

const ceiling = {
  principalKind: "service",
  principalId: "routine-forge-examples",
  grants: [],
  maxRiskClass: "high",
} as const;

describe("routine-forge examples", () => {
  it("finds the examples both files are supposed to ship", () => {
    expect(examples.length).toBeGreaterThanOrEqual(6);
  });

  it.each(examples.map((doc) => [String((doc.metadata as { slug: string }).slug), doc] as const))(
    "%s compiles, and every State is one the Worker executes",
    (_slug, document) => {
      const validated = definitions.routine.validateRoutineDefinition(document).document;
      const compiled = compileRoutine(validated, { identityCeiling: ceiling });

      for (const state of compiled.states.values()) {
        expect(WORKER_EXECUTES.has(state.type), `${state.name} is a ${state.type} State`).toBe(
          true
        );
      }
    }
  );

  /**
   * The shipped stars example once passed every check above while being impossible to run: it
   * named `record_create`'s arguments `resourceType`/`fields` rather than `type`/`data`. Compiling
   * proves the Routine's shape, not that a Tool would accept the arguments, and the executor test
   * that "proved" it used a fake action port that accepted anything. Validate the argument names
   * against the Tools themselves so a guessed key fails here rather than at the user's first Run.
   */
  it.each(
    examples.flatMap((document) => {
      const spec = document.spec as { states: readonly Record<string, unknown>[] };
      return spec.states
        .filter((state) => state.type === "action" && TOOL_INPUT_SCHEMAS.has(String(state.action)))
        .map(
          (state) =>
            [
              `${String((document.metadata as { slug: string }).slug)} / ${String(state.name)}`,
              String(state.action),
              (state.input ?? {}) as Record<string, unknown>,
            ] as const
        );
    })
  )("%s passes arguments the %s Tool actually declares", (_label, tool, input) => {
    const schema = TOOL_INPUT_SCHEMAS.get(tool);
    if (schema === undefined) throw new Error(`no schema for ${tool}`);
    const declared = new Set(Object.keys(schema.properties ?? {}));

    for (const required of schema.required ?? []) {
      expect(Object.hasOwn(input, required), `${tool} requires "${required}"`).toBe(true);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(input)) {
        expect(declared.has(key), `${tool} has no argument "${key}"`).toBe(true);
      }
    }
  });
});
