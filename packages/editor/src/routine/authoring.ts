import type { routine as routineSchema } from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface RoutineAuthoringIssue {
  readonly source: "yaml" | "schema" | "semantic";
  readonly path: string;
  readonly message: string;
}

export interface RoutineSimulationSummary {
  readonly resultHash: string;
  readonly steps: number;
  readonly effects: number;
}

export interface RoutineChangesetProposal {
  readonly baseHash: string;
  readonly yaml: string;
  readonly diff: string;
  readonly validationState: "valid";
  readonly simulation: RoutineSimulationSummary;
  readonly risk: "low" | "medium" | "high";
  readonly approval: "not_required" | "required";
  readonly publicationState: "draft";
}

export class RoutineAuthoringError extends Error {
  readonly name = "RoutineAuthoringError";

  constructor(readonly issues: readonly RoutineAuthoringIssue[]) {
    super("Routine authoring change is invalid");
  }
}

function clone(definition: routineSchema.RoutineDefinition): routineSchema.RoutineDefinition {
  return structuredClone(definition);
}

function yaml(definition: routineSchema.RoutineDefinition): string {
  return stringifyYaml(definition, { lineWidth: 100 });
}

class RoutineSemanticError extends Error {
  constructor(readonly path: string) {
    super("Routine graph reference does not resolve");
  }
}

class RoutineShapeError extends Error {
  constructor(readonly path: string) {
    super("Routine draft does not match the canonical authoring shape");
  }
}

function issue(error: unknown): RoutineAuthoringIssue {
  if (error instanceof RoutineSemanticError) {
    return { source: "semantic", path: error.path, message: error.message };
  }
  if (error instanceof RoutineShapeError) {
    return {
      source: "schema",
      path: error.path,
      message: error.message,
    };
  }
  return {
    source: "yaml",
    path: "",
    message: error instanceof Error ? error.message : "invalid YAML",
  };
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RoutineShapeError(path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RoutineShapeError(path);
  return value;
}

function validateShape(candidate: unknown): routineSchema.RoutineDefinition {
  const document = record(candidate, "");
  if (document.apiVersion !== "tulipfarm.ai/v1") {
    throw new RoutineShapeError("/apiVersion");
  }
  if (document.kind !== "Routine") throw new RoutineShapeError("/kind");
  const metadata = record(document.metadata, "/metadata");
  requireString(metadata.id, "/metadata/id");
  requireString(metadata.slug, "/metadata/slug");
  requireString(metadata.displayName, "/metadata/displayName");
  if (!Number.isInteger(metadata.schemaVersion)) {
    throw new RoutineShapeError("/metadata/schemaVersion");
  }
  if (!Number.isInteger(metadata.authoredVersion)) {
    throw new RoutineShapeError("/metadata/authoredVersion");
  }
  if (!["draft", "published", "retired"].includes(String(metadata.lifecycle))) {
    throw new RoutineShapeError("/metadata/lifecycle");
  }
  const spec = record(document.spec, "/spec");
  requireString(spec.start, "/spec/start");
  if (!Array.isArray(spec.states) || spec.states.length === 0) {
    throw new RoutineShapeError("/spec/states");
  }
  spec.states.forEach((state, index) => {
    const definition = record(state, `/spec/states/${index}`);
    requireString(definition.name, `/spec/states/${index}/name`);
    requireString(definition.type, `/spec/states/${index}/type`);
  });
  return structuredClone(document) as unknown as routineSchema.RoutineDefinition;
}

function validateGraph(definition: routineSchema.RoutineDefinition): void {
  const names = new Set<string>();
  for (const [index, state] of definition.spec.states.entries()) {
    if (names.has(state.name)) throw new RoutineSemanticError(`/spec/states/${index}/name`);
    names.add(state.name);
  }
  if (!names.has(definition.spec.start)) throw new RoutineSemanticError("/spec/start");
  const requireTarget = (target: unknown, path: string) => {
    if (typeof target === "string" && !names.has(target)) throw new RoutineSemanticError(path);
  };
  const readArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
  const readRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  for (const [index, state] of definition.spec.states.entries()) {
    const path = `/spec/states/${index}`;
    requireTarget(state.transition, `${path}/transition`);
    if (state.type === "branch") {
      readArray(state.conditions).forEach((condition, conditionIndex) => {
        requireTarget(
          readRecord(condition)?.transition,
          `${path}/conditions/${conditionIndex}/transition`
        );
      });
      requireTarget(readRecord(state.default)?.transition, `${path}/default/transition`);
    }
    if (state.type === "parallel") {
      readArray(state.branches).forEach((target, branchIndex) => {
        requireTarget(target, `${path}/branches/${branchIndex}`);
      });
    }
    if (state.type === "foreach" || state.type === "repeat_until") {
      requireTarget(state.body, `${path}/body`);
    }
    readArray(state.onError).forEach((handler, handlerIndex) => {
      requireTarget(readRecord(handler)?.transition, `${path}/onError/${handlerIndex}/transition`);
    });
  }
}

function validate(candidate: unknown): routineSchema.RoutineDefinition {
  const definition = validateShape(candidate);
  validateGraph(definition);
  return definition;
}

function changedLines(before: string, after: string): string {
  const left = before.trimEnd().split("\n");
  const right = after.trimEnd().split("\n");
  const lines: string[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const previous = left[index];
    const next = right[index];
    if (previous === next) continue;
    if (previous !== undefined) lines.push(`-${previous}`);
    if (next !== undefined) lines.push(`+${next}`);
  }
  return lines.join("\n");
}

function risk(
  definition: routineSchema.RoutineDefinition,
  changed: boolean
): "low" | "medium" | "high" {
  if (definition.spec.states.some((state) => state.type === "tool")) return "high";
  if (
    definition.spec.states.some((state) =>
      ["agent", "child_routine", "compensate"].includes(state.type)
    )
  ) {
    return "medium";
  }
  return changed ? "medium" : "low";
}

export interface RoutineAuthoringSession {
  snapshot(): routineSchema.RoutineDefinition;
  yaml(): string;
  updateSimple(input: { readonly displayName?: string; readonly owner?: string }): void;
  replaceGraphStates(states: readonly routineSchema.RoutineState[]): void;
  updateYaml(source: string): { readonly issues: readonly RoutineAuthoringIssue[] };
  proposal(simulation: RoutineSimulationSummary): RoutineChangesetProposal;
}

/**
 * One canonical draft backs simple, graph, and YAML modes. It emits a proposal only; publication
 * remains exclusively behind the server's strict Soul changeset/semantic/Approval gateway.
 */
export function createRoutineAuthoringSession(
  published: routineSchema.RoutineDefinition,
  baseHash: string
): RoutineAuthoringSession {
  const base = validate(published);
  const baseYaml = yaml(base);
  const { publishedDigest: _publishedDigest, ...draftMetadata } = base.metadata;
  let draft =
    base.metadata.lifecycle === "published"
      ? validate({
          ...clone(base),
          metadata: {
            ...draftMetadata,
            authoredVersion: base.metadata.authoredVersion + 1,
            lifecycle: "draft",
          },
        })
      : clone(base);

  const replace = (candidate: unknown): void => {
    try {
      draft = validate(candidate);
    } catch (error) {
      throw new RoutineAuthoringError([issue(error)]);
    }
  };

  return {
    snapshot: () => clone(draft),
    yaml: () => yaml(draft),
    updateSimple(input) {
      replace({
        ...draft,
        metadata: {
          ...draft.metadata,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        },
        spec: {
          ...draft.spec,
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
        },
      });
    },
    replaceGraphStates(states) {
      replace({ ...draft, spec: { ...draft.spec, states: structuredClone(states) } });
    },
    updateYaml(source) {
      try {
        const parsed: unknown = parseYaml(source);
        draft = validate(parsed);
        return { issues: [] };
      } catch (error) {
        return { issues: [issue(error)] };
      }
    },
    proposal(simulation) {
      const candidateYaml = yaml(draft);
      const diff = changedLines(baseYaml, candidateYaml);
      const candidateRisk = risk(draft, diff.length > 0);
      return {
        baseHash,
        yaml: candidateYaml,
        diff,
        validationState: "valid",
        simulation,
        risk: candidateRisk,
        approval: candidateRisk === "low" ? "not_required" : "required",
        publicationState: "draft",
      };
    },
  };
}
