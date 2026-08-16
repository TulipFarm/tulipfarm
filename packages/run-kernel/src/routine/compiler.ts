import type { routine as routineSchema } from "@tulipfarm/schema";
import { canonicalHash } from "@tulipfarm/schema";
import { type LimitSet, resolveLimits } from "../limits";
import type { JsonObject, OutputSchemaRegistration } from "../outputs";
import { mapAuthoredLimits } from "./authored-limits";
import { type CompiledExpression, compileExpression, ExpressionError } from "./expressions";
import { narrowBoundsByLimits } from "./limit-enforcement";

/**
 * Compiles valid Routine shapes into one graph after proving termination, reference order,
 * bounded cycles, and no identity or permission widening.
 */

export type RoutineCompileErrorCode =
  | "agent_not_permitted"
  | "bound_exceeds_ceiling"
  | "compensation_target_invalid"
  | "dangling_state"
  | "duplicate_state_name"
  | "identity_escalation"
  | "invalid_expression"
  | "permission_amplification"
  | "plan_too_large"
  | "risk_escalation"
  | "state_type_not_permitted"
  | "tool_not_permitted"
  | "unbounded_cycle"
  | "unknown_reference"
  | "unknown_start_state"
  | "unknown_transition_target"
  | "unreachable_reference"
  | "unreachable_state";

/** Denials include only reason code and JSON pointer, never authored values. */
export class RoutineCompileError extends Error {
  readonly name = "RoutineCompileError";

  constructor(
    readonly code: RoutineCompileErrorCode,
    readonly path: string
  ) {
    super(`${code}:${path}`);
  }
}

/** Hard ceilings every authored bound is capped at, whatever the Soul document claims. */
export const ROUTINE_BOUND_CEILINGS = {
  maxItems: 10_000,
  maxConcurrency: 64,
  maxIterations: 1_000,
  maxDurationMs: 86_400_000,
  maxAttempts: 100,
} as const;

export const RISK_CLASSES = ["low", "medium", "high"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export interface IdentityCeiling {
  readonly principalKind: string;
  readonly principalId: string;
  readonly grants: readonly string[];
  readonly maxRiskClass: RiskClass;
}

export interface CompiledMapping {
  readonly name: string;
  readonly expression: CompiledExpression | null;
  readonly literal: unknown;
}

export interface CompiledBranchArm {
  readonly condition: CompiledExpression;
  readonly transition: string | null;
  readonly end: boolean;
}

export interface CompiledErrorHandler {
  readonly errorRef: string;
  readonly transition: string | null;
  readonly end: boolean;
  readonly compensateWith: string | null;
}

export interface CompiledRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly multiplier: number;
}

export interface CompiledBounds {
  readonly maxItems: number | null;
  readonly maxConcurrency: number | null;
  readonly maxIterations: number | null;
  readonly maxDurationMs: number | null;
}

export interface CompiledState {
  readonly name: string;
  readonly type: routineSchema.RoutineStateType;
  readonly index: number;
  readonly transition: string | null;
  readonly end: boolean;
  readonly successors: readonly string[];
  readonly inputs: readonly CompiledMapping[];
  readonly conditions: readonly CompiledBranchArm[];
  readonly defaultTransition: string | null;
  readonly defaultEnd: boolean;
  readonly iterator: CompiledExpression | null;
  readonly body: string | null;
  readonly branches: readonly string[];
  readonly bounds: CompiledBounds;
  readonly join: "all" | "any" | "quorum" | null;
  readonly retry: CompiledRetryPolicy | null;
  readonly limits: LimitSet;
  readonly identity: { readonly principalKind: string; readonly principalId: string };
  readonly permissions: { readonly grants: readonly string[]; readonly maxRiskClass: RiskClass };
  readonly onError: readonly CompiledErrorHandler[];
  readonly outputSchemaRef: string | null;
  readonly concurrencyKey: string | null;
  readonly definition: Readonly<routineSchema.RoutineState>;
}

export interface CompiledRoutine {
  readonly slug: string;
  readonly authoredVersion: number;
  /** Canonical SHA-256 over the authored graph plus the ceiling it was compiled under. */
  readonly digest: string;
  readonly start: string;
  readonly states: ReadonlyMap<string, CompiledState>;
  readonly order: readonly string[];
  readonly identityCeiling: IdentityCeiling;
  readonly limits: LimitSet;
  readonly requiredToolAbilities: readonly string[];
  readonly outputSchemas: readonly OutputSchemaRegistration[];
}

export interface CompileRoutineOptions {
  readonly identityCeiling: IdentityCeiling;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime key reads intentionally opt out of the index-signature-free `RoutineState` union. */
export function stateFields(state: routineSchema.RoutineState): Record<string, unknown> {
  return state as unknown as Record<string, unknown>;
}

function readString(state: routineSchema.RoutineState, key: string): string | null {
  const value = stateFields(state)[key];
  return typeof value === "string" ? value : null;
}

function readNumber(state: routineSchema.RoutineState, key: string): number | null {
  const value = stateFields(state)[key];
  return typeof value === "number" ? value : null;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    result[key] = stripUndefined(value[key]);
  }
  return result as T;
}

const EXPRESSION_PATTERN = /^\$\{([\s\S]*)\}$/;

function compileAt(source: string, path: string): CompiledExpression {
  try {
    return compileExpression(source);
  } catch (error) {
    if (error instanceof ExpressionError) throw new RoutineCompileError("invalid_expression", path);
    throw error;
  }
}

function successorsOf(state: routineSchema.RoutineState): string[] {
  const targets: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && !targets.includes(value)) targets.push(value);
  };
  push(state.transition);
  for (const handler of readArray(state, "onError")) {
    if (isRecord(handler)) push(handler.transition);
  }
  for (const condition of readArray(state, "conditions")) {
    if (isRecord(condition)) push(condition.transition);
  }
  const fallback = readRecord(state, "default");
  if (fallback) push(fallback.transition);
  for (const branch of readArray(state, "branches")) push(branch);
  if (state.type === "foreach" || state.type === "repeat_until") push(state.body);
  return targets;
}

function stronglyConnected(
  order: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let counter = 0;

  const walk = (name: string): void => {
    index.set(name, counter);
    low.set(name, counter);
    counter += 1;
    stack.push(name);
    onStack.add(name);
    for (const next of edges.get(name) ?? []) {
      if (!index.has(next)) {
        walk(next);
        low.set(name, Math.min(low.get(name) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(name, Math.min(low.get(name) as number, index.get(next) as number));
      }
    }
    if (low.get(name) === index.get(name)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
        if (member === name) break;
      }
      components.push(component);
    }
  };

  for (const name of order) if (!index.has(name)) walk(name);
  return components;
}

function reachableFrom(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of edges.get(queue.shift() as string) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

const BOUNDED_STATE_TYPES: ReadonlySet<routineSchema.RoutineStateType> = new Set([
  "foreach",
  "repeat_until",
]);

function riskRank(value: RiskClass): number {
  return RISK_CLASSES.indexOf(value);
}

function checkIdentity(
  state: routineSchema.RoutineState,
  path: string,
  ceiling: IdentityCeiling
): void {
  const identity = readRecord(state, "identity");
  if (
    identity !== null &&
    (identity.principalKind !== ceiling.principalKind ||
      identity.principalId !== ceiling.principalId)
  ) {
    throw new RoutineCompileError("identity_escalation", `${path}/identity`);
  }
  const permissions = readRecord(state, "permissionCeiling");
  if (permissions === null) return;
  for (const grant of readArray(permissions, "grants")) {
    if (typeof grant !== "string" || !ceiling.grants.includes(grant)) {
      throw new RoutineCompileError("permission_amplification", `${path}/permissionCeiling/grants`);
    }
  }
  const risk = permissions.maxRiskClass;
  if (typeof risk === "string" && riskRank(risk as RiskClass) > riskRank(ceiling.maxRiskClass)) {
    throw new RoutineCompileError("risk_escalation", `${path}/permissionCeiling/maxRiskClass`);
  }
}

function checkBounds(state: routineSchema.RoutineState, path: string): CompiledBounds {
  const bounded = (key: keyof typeof ROUTINE_BOUND_CEILINGS): number | null => {
    const value = readNumber(state, key);
    if (value === null) return null;
    if (value > ROUTINE_BOUND_CEILINGS[key]) {
      throw new RoutineCompileError("bound_exceeds_ceiling", `${path}/${key}`);
    }
    return value;
  };
  return {
    maxItems: bounded("maxItems"),
    maxConcurrency: bounded("maxConcurrency"),
    maxIterations: bounded("maxIterations"),
    maxDurationMs: bounded("maxDurationMs"),
  };
}

function compileRetry(state: routineSchema.RoutineState, path: string): CompiledRetryPolicy | null {
  const retry = readRecord(state, "retry");
  if (retry === null) return null;
  const maxAttempts = typeof retry.maxAttempts === "number" ? retry.maxAttempts : 1;
  if (maxAttempts > ROUTINE_BOUND_CEILINGS.maxAttempts) {
    throw new RoutineCompileError("bound_exceeds_ceiling", `${path}/retry/maxAttempts`);
  }
  return {
    maxAttempts,
    backoffMs: typeof retry.backoffMs === "number" ? retry.backoffMs : 0,
    multiplier: typeof retry.multiplier === "number" ? retry.multiplier : 1,
  };
}

function canProgress(state: routineSchema.RoutineState): boolean {
  if (state.end === true || typeof state.transition === "string") return true;
  const fallback = readRecord(state, "default");
  if (fallback !== null && (fallback.end === true || typeof fallback.transition === "string")) {
    return true;
  }
  for (const handler of readArray(state, "onError")) {
    if (isRecord(handler) && (handler.end === true || typeof handler.transition === "string")) {
      return true;
    }
  }
  return false;
}

/**
 * Compile one authored Routine into an immutable typed graph under an explicit identity ceiling.
 * The ceiling is required: a Routine is never compiled "unbounded and authorized later".
 */
export function compileRoutine(
  definition: routineSchema.RoutineDefinition,
  options: CompileRoutineOptions
): CompiledRoutine {
  const ceiling = options.identityCeiling;
  const states = definition.spec.states;
  const byName = new Map<string, { state: routineSchema.RoutineState; index: number }>();

  for (const [index, state] of states.entries()) {
    if (byName.has(state.name)) {
      throw new RoutineCompileError("duplicate_state_name", `/spec/states/${index}/name`);
    }
    byName.set(state.name, { state, index });
  }

  const start = definition.spec.start;
  if (!byName.has(start)) throw new RoutineCompileError("unknown_start_state", "/spec/start");

  const edges = new Map<string, readonly string[]>();

  for (const [index, state] of states.entries()) {
    const path = `/spec/states/${index}`;
    checkIdentity(state, path, ceiling);
    checkBounds(state, path);
    compileRetry(state, path);

    const requireTarget = (target: unknown, targetPath: string): void => {
      if (typeof target !== "string") return;
      if (!byName.has(target)) {
        throw new RoutineCompileError("unknown_transition_target", targetPath);
      }
    };
    requireTarget(state.transition, `${path}/transition`);
    for (const [i, handler] of readArray(state, "onError").entries()) {
      if (!isRecord(handler)) continue;
      requireTarget(handler.transition, `${path}/onError/${i}/transition`);
      if (typeof handler.compensateWith === "string") {
        const target = byName.get(handler.compensateWith);
        if (target === undefined || target.state.type !== "compensate") {
          throw new RoutineCompileError(
            "compensation_target_invalid",
            `${path}/onError/${i}/compensateWith`
          );
        }
      }
    }
    for (const [i, condition] of readArray(state, "conditions").entries()) {
      if (isRecord(condition)) {
        requireTarget(condition.transition, `${path}/conditions/${i}/transition`);
      }
    }
    const fallback = readRecord(state, "default");
    if (fallback) requireTarget(fallback.transition, `${path}/default/transition`);
    for (const [i, branch] of readArray(state, "branches").entries()) {
      requireTarget(branch, `${path}/branches/${i}`);
    }
    if (state.type === "foreach" || state.type === "repeat_until") {
      requireTarget(state.body, `${path}/body`);
    }

    if (state.type === "compensate") {
      const forState = readString(state, "forState");
      const target = forState === null ? undefined : byName.get(forState);
      if (forState !== null && (target === undefined || target.state.type !== "tool")) {
        throw new RoutineCompileError("compensation_target_invalid", `${path}/forState`);
      }
    }

    if (!canProgress(state)) throw new RoutineCompileError("dangling_state", path);

    edges.set(state.name, successorsOf(state));
  }

  const reachable = reachableFrom(start, edges);
  for (const [index, state] of states.entries()) {
    if (!reachable.has(state.name)) {
      throw new RoutineCompileError("unreachable_state", `/spec/states/${index}`);
    }
  }

  const order = states.map((state) => state.name);
  for (const component of stronglyConnected(order, edges)) {
    const cyclic =
      component.length > 1 ||
      (edges.get(component[0] as string) ?? []).includes(component[0] as string);
    if (!cyclic) continue;
    if (component.some((name) => BOUNDED_STATE_TYPES.has(byName.get(name)?.state.type as never))) {
      continue;
    }
    const lowest = component
      .map((name) => byName.get(name)?.index ?? 0)
      .reduce((a, b) => Math.min(a, b));
    throw new RoutineCompileError("unbounded_cycle", `/spec/states/${lowest}`);
  }

  const digest = canonicalHash(
    stripUndefined({
      slug: definition.metadata.slug,
      authoredVersion: definition.metadata.authoredVersion,
      ceiling: {
        principalKind: ceiling.principalKind,
        principalId: ceiling.principalId,
        grants: [...ceiling.grants].sort(),
        maxRiskClass: ceiling.maxRiskClass,
      },
      spec: definition.spec as unknown as JsonObject,
    })
  );

  // Every reference must resolve to a State that can actually precede its reader.
  const proveReferences = (expression: CompiledExpression, reader: string, path: string): void => {
    for (const reference of expression.references) {
      const [root, target] = reference.split(".");
      if (root !== "states" || target === undefined) continue;
      if (!byName.has(target)) throw new RoutineCompileError("unknown_reference", path);
      if (!reachableFrom(target, edges).has(reader)) {
        throw new RoutineCompileError("unreachable_reference", path);
      }
    }
  };

  const compiled = new Map<string, CompiledState>();
  const routineLimits = mapAuthoredLimits(definition.spec.limits ?? {});
  const outputSchemas: OutputSchemaRegistration[] = [];

  for (const [index, state] of states.entries()) {
    const path = `/spec/states/${index}`;

    const inputs: CompiledMapping[] = [];
    for (const name of Object.keys(readRecord(state, "input") ?? {}).sort()) {
      const value = (readRecord(state, "input") as Record<string, unknown>)[name];
      const match = typeof value === "string" ? EXPRESSION_PATTERN.exec(value) : null;
      if (match === null) {
        inputs.push({ name, expression: null, literal: value });
        continue;
      }
      const expression = compileAt(match[1] as string, `${path}/input/${name}`);
      proveReferences(expression, state.name, `${path}/input/${name}`);
      inputs.push({ name, expression, literal: undefined });
    }

    const conditions: CompiledBranchArm[] = [];
    for (const [i, arm] of readArray(state, "conditions").entries()) {
      if (!isRecord(arm) || typeof arm.condition !== "string") continue;
      const conditionPath = `${path}/conditions/${i}/condition`;
      const expression = compileAt(arm.condition, conditionPath);
      proveReferences(expression, state.name, conditionPath);
      conditions.push({
        condition: expression,
        transition: typeof arm.transition === "string" ? arm.transition : null,
        end: arm.end === true,
      });
    }

    let iterator: CompiledExpression | null = null;
    const iteratorSource = readString(state, "items") ?? readString(state, "condition");
    if (iteratorSource !== null) {
      const iteratorPath = `${path}/${state.type === "foreach" ? "items" : "condition"}`;
      iterator = compileAt(iteratorSource, iteratorPath);
      proveReferences(iterator, state.name, iteratorPath);
    }

    const onError: CompiledErrorHandler[] = [];
    for (const handler of readArray(state, "onError")) {
      if (!isRecord(handler) || typeof handler.errorRef !== "string") continue;
      onError.push({
        errorRef: handler.errorRef,
        transition: typeof handler.transition === "string" ? handler.transition : null,
        end: handler.end === true,
        compensateWith: typeof handler.compensateWith === "string" ? handler.compensateWith : null,
      });
    }

    const outputSchema = readRecord(state, "output");
    const outputSchemaRef = outputSchema === null ? null : `${digest}#/states/${state.name}/output`;
    if (outputSchema !== null && outputSchemaRef !== null) {
      outputSchemas.push({ ref: outputSchemaRef, schema: outputSchema as JsonObject });
    }

    const permissions = readRecord(state, "permissionCeiling");
    const fallback = readRecord(state, "default");
    const stateLimits = mapAuthoredLimits(readRecord(state, "limits") ?? {});
    // Narrowest wins across the two scopes an authored Routine can declare (SPEC §9.1), so a
    // State ceiling tightens the Routine's and never raises it.
    const boundCeilings = resolveLimits([
      { scope: "routine", limits: routineLimits },
      { scope: "state", limits: stateLimits },
    ]);

    compiled.set(
      state.name,
      Object.freeze({
        name: state.name,
        type: state.type,
        index,
        transition: readString(state, "transition"),
        end: state.end === true,
        successors: Object.freeze([...(edges.get(state.name) ?? [])]),
        inputs: Object.freeze(inputs),
        conditions: Object.freeze(conditions),
        defaultTransition:
          fallback !== null && typeof fallback.transition === "string" ? fallback.transition : null,
        defaultEnd: fallback?.end === true,
        iterator,
        body: readString(state, "body"),
        branches: Object.freeze(
          readArray(state, "branches").filter((b): b is string => typeof b === "string")
        ),
        bounds: narrowBoundsByLimits(checkBounds(state, path), boundCeilings),
        join: (readString(state, "join") as CompiledState["join"]) ?? null,
        retry: compileRetry(state, path),
        limits: stateLimits,
        identity: {
          principalKind: ceiling.principalKind,
          principalId: ceiling.principalId,
        },
        permissions: {
          grants: Object.freeze(
            (readArray(permissions ?? {}, "grants") as string[]).length > 0
              ? (readArray(permissions ?? {}, "grants") as string[])
              : [...ceiling.grants]
          ),
          maxRiskClass:
            (permissions?.maxRiskClass as RiskClass | undefined) ?? ceiling.maxRiskClass,
        },
        onError: Object.freeze(onError),
        outputSchemaRef,
        concurrencyKey: readString(state, "concurrencyKey"),
        definition: Object.freeze(state),
      })
    );
  }

  return Object.freeze({
    slug: definition.metadata.slug,
    authoredVersion: definition.metadata.authoredVersion,
    digest,
    start,
    states: compiled,
    order: Object.freeze(order),
    identityCeiling: Object.freeze({ ...ceiling, grants: Object.freeze([...ceiling.grants]) }),
    limits: routineLimits,
    requiredToolAbilities: Object.freeze([...(definition.spec.requiredToolAbilities ?? [])]),
    outputSchemas: Object.freeze(outputSchemas),
  });
}
