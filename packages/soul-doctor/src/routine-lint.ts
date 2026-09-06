import {
  type CompiledRoutine,
  type CompiledState,
  compileRoutine,
  type IdentityCeiling,
  inputNodeExpressions,
  RoutineCompileError,
  stateFields,
} from "@tulipfarm/run-kernel";
import {
  isRecord,
  routine as routineDefinitions,
  type routine as routineSchema,
} from "@tulipfarm/schema";
import { type Finding, finding } from "./finding";

/**
 * The ceiling a lint compiles under.
 *
 * It is deliberately the widest one the compiler accepts. The Doctor is proving that a Routine is
 * *structurally* sound — its States exist, its references resolve, its graph terminates — and a
 * narrow ceiling would turn "this deployment would not authorize it" into a defect report about
 * the artifact, which it is not. Authority is decided per Run, against the caller's own ceiling,
 * and that decision is not the Doctor's to pre-empt.
 */
export const LINT_CEILING: IdentityCeiling = Object.freeze({
  principalKind: "service",
  principalId: "soul-doctor",
  grants: Object.freeze([]) as readonly string[],
  maxRiskClass: "high",
});

/** Reads the `output:` JSON Schema a State may declare, when it declares a closed object one. */
function declaredOutputProperties(state: CompiledState): ReadonlySet<string> | null {
  const schema = stateFields(state.definition as routineSchema.RoutineState).output;
  if (!isRecord(schema)) return null;
  // An open schema promises nothing about absent keys, so an unlisted field is not a defect.
  if (schema.additionalProperties !== false) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;
  return new Set(Object.keys(properties));
}

/**
 * Field-level reference check.
 *
 * `compileRoutine` already proves that `${states.X...}` names a State that can precede its reader
 * — that is `unknown_reference` and `unreachable_reference`. What it cannot prove is that `X`
 * publishes the *field* being read, because most States have no declared output shape and the
 * value only exists at run time. Where an author did declare a closed `output` schema, the
 * mismatch is provable here instead of at 3am on a Run nobody was watching.
 */
function outputFieldFindings(
  compiled: CompiledRoutine,
  slug: string,
  digest: string
): readonly Finding[] {
  const found: Finding[] = [];
  for (const state of compiled.states.values()) {
    const expressions = state.inputs.flatMap((mapping) => inputNodeExpressions(mapping.node));
    for (const expression of expressions) {
      for (const reference of expression.references) {
        const [root, target, output, field] = reference.split(".");
        if (root !== "states" || output !== "output" || target === undefined) continue;
        if (field === undefined) continue;
        const producer = compiled.states.get(target);
        if (producer === undefined) continue;
        const properties = declaredOutputProperties(producer);
        if (properties === null || properties.has(field)) continue;
        found.push(
          finding({
            code: "undeclared_output_field",
            severity: "broken",
            subject: { kind: "routine", id: slug, digest },
            at: `${state.name}:${reference}`,
            detail:
              `State \`${state.name}\` reads \`${reference}\`, but State \`${target}\` declares ` +
              `an output schema without a \`${field}\` field. The mapping cannot resolve, so the ` +
              `Run fails the moment it reaches \`${state.name}\`.`,
          })
        );
      }
    }
  }
  return found;
}

/**
 * An `action` State dispatches a runtime Tool named in `action`. Without it the executor refuses
 * with `missing_action_name` and the Run stops — but the compiler accepts the document, so this
 * is a defect that only ever announces itself by failing.
 */
function missingActionFindings(
  compiled: CompiledRoutine,
  slug: string,
  digest: string
): readonly Finding[] {
  const found: Finding[] = [];
  for (const state of compiled.states.values()) {
    if (state.type !== "action") continue;
    const action = stateFields(state.definition as routineSchema.RoutineState).action;
    if (typeof action === "string" && action.length > 0) continue;
    found.push(
      finding({
        code: "missing_action_name",
        severity: "broken",
        subject: { kind: "routine", id: slug, digest },
        at: state.name,
        detail: `\`action\` State \`${state.name}\` names no Tool to call, so no executor can run it.`,
      })
    );
  }
  return found;
}

export interface RoutineLintInput {
  readonly slug: string;
  /** Content hash of the published document, so a finding is pinned to the exact bytes it proves. */
  readonly digest: string;
  readonly definition: routineSchema.RoutineDefinition;
}

/**
 * Every defect provable from one published Routine, with no model, no fixtures and no live ports.
 *
 * A compile failure short-circuits: with no graph there is nothing further to prove, and reporting
 * ten consequences of one broken edge buries the edge.
 */
export function lintRoutine(input: RoutineLintInput): readonly Finding[] {
  const { slug, digest, definition } = input;
  let compiled: CompiledRoutine;
  try {
    compiled = compileRoutine(definition, { identityCeiling: LINT_CEILING });
  } catch (error) {
    if (!(error instanceof RoutineCompileError)) throw error;
    return [
      finding({
        code: "routine_uncompilable",
        severity: "broken",
        subject: { kind: "routine", id: slug, digest },
        at: error.path,
        detail:
          `The published Routine does not compile: \`${error.code}\` at \`${error.path}\`. ` +
          "No Run of it can start.",
      }),
    ];
  }
  return [
    ...outputFieldFindings(compiled, slug, digest),
    ...missingActionFindings(compiled, slug, digest),
  ];
}

export interface RoutineDocumentLintInput {
  readonly slug: string;
  readonly digest: string;
  /** The authored document as parsed from YAML — unvalidated, because a hand-edit may break it. */
  readonly document: unknown;
}

/**
 * Lints a Routine straight from its authored bytes.
 *
 * The schema check has to happen here rather than at the caller: a document pushed to the soul
 * repo by hand can fail it, and a Doctor that could only read already-valid Routines would be
 * blind to exactly the edit most likely to break one.
 */
export function lintRoutineDocument(input: RoutineDocumentLintInput): readonly Finding[] {
  const { slug, digest, document } = input;
  let definition: routineSchema.RoutineDefinition;
  try {
    definition = routineDefinitions.validateRoutineDefinition(document)
      .document as routineSchema.RoutineDefinition;
  } catch (error) {
    return [
      finding({
        code: "routine_schema_invalid",
        severity: "broken",
        subject: { kind: "routine", id: slug, digest },
        at: "document",
        detail:
          `The authored Routine does not satisfy the Routine schema: ` +
          `${error instanceof Error ? error.message : String(error)}. It cannot be published.`,
      }),
    ];
  }
  return lintRoutine({ slug, digest, definition });
}
