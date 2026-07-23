import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { analyzeCapabilities } from "./capability-analysis";
import {
  type AuthoredDefinition,
  asDefinitionRef,
  collectReferenceEdges,
  DefinitionIndex,
  resolveReferences,
  type SoulSemanticIssue,
  SoulSemanticValidationError,
  sortIssues,
} from "./refs";

/**
 * Semantic graph validation (SPEC §8.2 step 6) plus the public tree-level entrypoint that
 * orchestrates identifier uniqueness (AW-011 → {@link DefinitionIndex}), reference resolution
 * ({@link resolveReferences}), and non-amplification ({@link analyzeCapabilities}).
 *
 * This runs after strict per-file AJV validation and before signing/compilation. It is
 * synchronous, side-effect free, and deterministic; issues are payload-safe.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ── Routine internal State graph ────────────────────────────────────────────────

/** All state names a State can transition to, with the JSON pointer of each edge. */
function stateEdges(state: Record<string, unknown>, base: string): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  const add = (value: unknown, field: string) => {
    if (typeof value === "string") edges.push([value, field]);
  };
  add(state.transition, `${base}/transition`);
  if (Array.isArray(state.onError)) {
    state.onError.forEach((handler, i) => {
      if (isRecord(handler)) add(handler.transition, `${base}/onError/${i}/transition`);
    });
  }
  if (state.type === "branch") {
    if (Array.isArray(state.conditions)) {
      state.conditions.forEach((c, i) => {
        if (isRecord(c)) add(c.transition, `${base}/conditions/${i}/transition`);
      });
    }
    if (isRecord(state.default)) add(state.default.transition, `${base}/default/transition`);
  } else if (state.type === "parallel") {
    stringList(state.branches).forEach((b, i) => {
      edges.push([b, `${base}/branches/${i}`]);
    });
  } else if (state.type === "foreach" || state.type === "repeat_until") {
    add(state.body, `${base}/body`);
  } else if (state.type === "compensate") {
    add(state.forState, `${base}/forState`);
  }
  return edges;
}

function checkRoutineGraph(def: AuthoredDefinition): SoulSemanticIssue[] {
  const issues: SoulSemanticIssue[] = [];
  const states = Array.isArray(def.spec.states) ? def.spec.states : [];
  const names = new Set<string>();
  states.forEach((state, i) => {
    if (!isRecord(state) || typeof state.name !== "string") return;
    if (names.has(state.name)) {
      issues.push({
        code: "ROUTINE_DUPLICATE_STATE",
        subject: def.subject,
        ref: state.name,
        field: `/spec/states/${i}/name`,
      });
    } else {
      names.add(state.name);
    }
  });

  const start = def.spec.start;
  if (typeof start === "string" && !names.has(start)) {
    issues.push({
      code: "ROUTINE_START_UNKNOWN",
      subject: def.subject,
      ref: start,
      field: "/spec/start",
    });
  }

  states.forEach((state, i) => {
    if (!isRecord(state)) return;
    for (const [target, field] of stateEdges(state, `/spec/states/${i}`)) {
      if (!names.has(target)) {
        issues.push({
          code: "ROUTINE_TRANSITION_UNKNOWN",
          subject: def.subject,
          ref: target,
          field,
        });
      }
    }
  });
  return issues;
}

function checkRoutineGraphs(index: DefinitionIndex): SoulSemanticIssue[] {
  return index.ofKind("Routine").flatMap(checkRoutineGraph);
}

// ── Reference cycles (Role inheritance, ModelProfile fallbacks) ─────────────────

/**
 * Detect a cycle reachable from `def` over a plain-ref adjacency (slug or id). Reports one
 * issue on the definition that closes the cycle back onto itself, so the same cycle surfaces
 * deterministically regardless of traversal order.
 */
function detectCycle(
  index: DefinitionIndex,
  code: SoulSemanticIssue["code"],
  kind: string,
  field: string,
  adjacency: (def: AuthoredDefinition) => string[]
): SoulSemanticIssue[] {
  const issues: SoulSemanticIssue[] = [];
  const resolve = (ref: string): AuthoredDefinition | undefined => {
    const byId = index.get(ref);
    if (byId?.kind === kind) return byId;
    return index.candidates(ref, kind)[0];
  };
  for (const start of index.ofKind(kind)) {
    const stack = new Set<string>();
    let closes = false;
    const walk = (def: AuthoredDefinition): void => {
      if (closes) return;
      stack.add(def.id);
      for (const ref of adjacency(def)) {
        const next = resolve(ref);
        if (!next) continue;
        if (next.id === start.id) {
          closes = true;
          return;
        }
        if (!stack.has(next.id)) walk(next);
      }
      stack.delete(def.id);
    };
    walk(start);
    if (closes) {
      issues.push({ code, subject: start.subject, field });
    }
  }
  return issues;
}

function checkCycles(index: DefinitionIndex): SoulSemanticIssue[] {
  return [
    ...detectCycle(index, "INHERITANCE_CYCLE", "Role", "/spec/inherits", (d) =>
      stringList(d.spec.inherits)
    ),
    ...detectCycle(index, "FALLBACK_CYCLE", "ModelProfile", "/spec/fallbacks", (d) =>
      stringList(d.spec.fallbacks)
    ),
  ];
}

function checkStableIdVersions(index: DefinitionIndex): SoulSemanticIssue[] {
  const issues: SoulSemanticIssue[] = [];
  for (const def of index.all) {
    for (const edge of collectReferenceEdges(def)) {
      if (edge.form !== "versioned") continue;
      const ref = asDefinitionRef(edge.value);
      if (ref?.id === undefined || ref.version === "*" || ref.version === "latest") {
        continue;
      }
      const target = index.get(ref.id);
      if (target?.kind === edge.kind && String(target.authoredVersion) !== ref.version) {
        issues.push({
          code: "VERSION_UNSATISFIED",
          subject: def.subject,
          ref: ref.version,
          field: `${edge.field}/version`,
        });
      }
    }
  }
  return issues;
}

// ── Public entrypoint ───────────────────────────────────────────────────────────

/**
 * Validate the semantic graph and cross-references of a proposed Soul tree. `documents` are the
 * strict-AJV-validated authored definitions of the proposed tree (base tree merged with the
 * changeset). Throws {@link SoulSemanticValidationError} with all issues if any check fails.
 */
export function validateSoulSemantics(documents: readonly VersionedSchemaDocument[]): void {
  const { index, issues: identityIssues } = DefinitionIndex.build(documents);
  const issues = sortIssues([
    ...identityIssues,
    ...resolveReferences(index),
    ...checkStableIdVersions(index),
    ...checkRoutineGraphs(index),
    ...checkCycles(index),
    ...analyzeCapabilities(index),
  ]);
  if (issues.length > 0) throw new SoulSemanticValidationError(issues);
}
