import {
  canonicalHash,
  isRecord,
  type PlanStep,
  parseYamlDocument,
  routine,
  SchemaContractError,
  validatePlanDefinition,
  YAML_PLAN_MAX_BYTES,
} from "@tulipfarm/schema";
import { compileRoutine, RoutineCompileError } from "./compiler";
import { compileExpression, ExpressionError, parseTemplate } from "./expressions";

/** Child Routine calls must have a finite durable-wait deadline. */
export const YAML_PLAN_CHILD_DEADLINE_MS = 86_400_000;

export class YamlPlanError extends Error {
  readonly name = "YamlPlanError";

  constructor(
    readonly code: string,
    readonly path: string,
    message = code
  ) {
    super(`${message} at ${path || "/"}`);
  }
}

export interface CompiledYamlPlan {
  readonly definition: routine.RoutineDefinition;
  readonly rounds: readonly {
    readonly calls: readonly { readonly tool: string; readonly label: string }[];
  }[];
  readonly steps: readonly {
    readonly id: string;
    readonly needs: readonly string[];
    readonly label: string;
  }[];
}

function pointer(path: string, key: string): string {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function checkExpressions(
  value: unknown,
  ancestors: ReadonlySet<string>,
  childSteps: ReadonlySet<string>,
  path: string
): void {
  if (typeof value === "string") {
    try {
      for (const segment of parseTemplate(value)) {
        if (segment.kind !== "expression") continue;
        const expression = compileExpression(segment.source, { roots: ["input", "states"] });
        for (const reference of expression.references) {
          const [root, target, field] = reference.split(".");
          if (root !== "states") continue;
          if (!target || field !== "output" || !ancestors.has(target)) {
            throw new YamlPlanError("undeclared_state_reference", path);
          }
          if (childSteps.has(target)) {
            throw new YamlPlanError(
              "child_output_unavailable",
              path,
              "Child Routine completion does not expose an output value"
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new YamlPlanError("invalid_expression", path, error.code);
      }
      throw error;
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, index) => {
      checkExpressions(child, ancestors, childSteps, `${path}/${index}`);
    });
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      checkExpressions(child, ancestors, childSteps, pointer(path, key));
    }
  }
}

function dependencyRounds(steps: readonly PlanStep[]): PlanStep[][] {
  const ids = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (ids.has(step.id)) throw new YamlPlanError("duplicate_step_id", `/steps/${index}/id`);
    ids.add(step.id);
  }
  for (const [index, step] of steps.entries()) {
    for (const [dependencyIndex, dependency] of (step.needs ?? []).entries()) {
      const path = `/steps/${index}/needs/${dependencyIndex}`;
      if (dependency === step.id) throw new YamlPlanError("self_dependency", path);
      if (!ids.has(dependency)) throw new YamlPlanError("unknown_dependency", path);
    }
  }
  const completed = new Set<string>();
  const rounds: PlanStep[][] = [];
  while (completed.size < steps.length) {
    const ready = steps.filter(
      (step) => !completed.has(step.id) && (step.needs ?? []).every((id) => completed.has(id))
    );
    if (ready.length === 0) throw new YamlPlanError("dependency_cycle", "/steps");
    rounds.push(ready);
    for (const step of ready) completed.add(step.id);
  }
  return rounds;
}

function stateFor(step: PlanStep): routine.RoutineState {
  const common = { name: step.id, input: step.input ?? {} };
  if ("tool" in step) return { ...common, type: "action", action: step.tool };
  if ("routine" in step) {
    return {
      ...common,
      type: "child_routine",
      routineRef: step.routine,
      mode: "wait",
      deadlineMs: YAML_PLAN_CHILD_DEADLINE_MS,
    };
  }
  return {
    ...common,
    type: "agent",
    agentRef: step.agent,
    input: { ...step.input, prompt: step.prompt },
    ...(step.requiredToolCalls === undefined ? {} : { requiredToolCalls: step.requiredToolCalls }),
    ...(step.output === undefined ? {} : { output: step.output }),
  };
}

/**
 * Lowers a declarative DAG to the durable Routine executor, without minting caller authority.
 * Rounds describe dependency frontiers, not physical concurrency: fan-out isolates branch outputs,
 * so States form a stable topological chain until the executor supports exporting branch outputs.
 */
export function compileYamlPlan(source: string): CompiledYamlPlan {
  if (Buffer.byteLength(source, "utf8") > YAML_PLAN_MAX_BYTES) {
    throw new YamlPlanError("source_too_large", "");
  }
  try {
    const plan = validatePlanDefinition(parseYamlDocument(source)).document;
    const rounds = dependencyRounds(plan.steps);
    const ordered = rounds.flat();
    const childSteps = new Set(
      plan.steps.filter((step) => "routine" in step).map((step) => step.id)
    );
    const ancestors = new Map<string, Set<string>>();
    for (const step of ordered) {
      const inherited = new Set<string>();
      for (const dependency of step.needs ?? []) {
        inherited.add(dependency);
        for (const ancestor of ancestors.get(dependency) ?? []) inherited.add(ancestor);
      }
      ancestors.set(step.id, inherited);
      const path = `/steps/${plan.steps.indexOf(step)}`;
      if ("agent" in step && Object.hasOwn(step.input ?? {}, "prompt")) {
        throw new YamlPlanError("prompt_collision", `${path}/input/prompt`);
      }
      checkExpressions(step.input, inherited, childSteps, `${path}/input`);
      if ("agent" in step) checkExpressions(step.prompt, inherited, childSteps, `${path}/prompt`);
    }
    const states = ordered.map((step, index): routine.RoutineState => {
      const next = ordered[index + 1];
      return { ...stateFor(step), ...(next ? { transition: next.id } : { end: true }) };
    });
    /** Definition metadata requires UUID/ULID, not the synthetic `plan:<name>` identifier. */
    const hash = canonicalHash({ kind: "Plan", name: plan.name });
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const definition: routine.RoutineDefinition = {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id,
        slug: plan.name,
        schemaVersion: 1,
        authoredVersion: plan.version,
        lifecycle: "published",
      },
      spec: {
        owner: `plan:${plan.name}`,
        start: ordered[0].id,
        states,
      },
    };
    routine.validateRoutineDefinition(definition);
    /** This zero-authority compilation is validation only; execution recompiles under its Run. */
    compileRoutine(definition, {
      identityCeiling: {
        principalKind: "service",
        principalId: "plan-validation",
        grants: [],
        maxRiskClass: "low",
      },
    });
    return {
      definition,
      rounds: rounds.map((frontier) => ({
        calls: frontier.map((step) => ({
          tool: "tool" in step ? step.tool : "agent" in step ? "agent" : "routine",
          label: step.label ?? step.id,
        })),
      })),
      steps: plan.steps.map((step) => ({
        id: step.id,
        needs: step.needs ?? [],
        label: step.label ?? step.id,
      })),
    };
  } catch (error) {
    if (error instanceof SchemaContractError || error instanceof RoutineCompileError) {
      throw new YamlPlanError(error.code, error.path, error.message);
    }
    throw error;
  }
}
