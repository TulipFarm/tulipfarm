import { canonicalHash } from "@tulipfarm/schema";
import type { JsonObject } from "./outputs";
import type { CompiledRoutine, CompiledState } from "./routine/compiler";
import { RoutineInputResolutionError, resolveRoutineStateInput } from "./routine/input";
import { decideBranch } from "./routine/states/branch";
import { type StepOutcome, stateOutcome } from "./routine/states/step";

/**
 * Deterministic Routine simulation (SPEC §9.2).
 *
 * A simulation executes an already-compiled Routine against a fixture clock, fixture model
 * outputs, fixture Tool results, and fixture events. It has no ports: there is nothing here to
 * lease a Secret with and nothing to dispatch an effect through, so a simulated Run cannot touch
 * a live system even by mistake. A `tool` State produces an {@link EffectPreview} — what would
 * have been dispatched, under which identity, with which resolved input — and the Run continues
 * from the fixture result. Two simulations of the same Routine and fixture produce byte-identical
 * results, including {@link SimulationResult.resultHash}, which is what makes replay diffable.
 */

export type SimulationErrorCode =
  | "effect_dispatch_denied"
  | "fixture_missing"
  | "secret_lease_denied"
  | "state_not_simulable"
  | "step_budget_exceeded"
  | "unknown_state";

/** A simulation denial. Carries only `code:subject` — never a fixture value or a Secret. */
export class SimulationError extends Error {
  constructor(
    readonly code: SimulationErrorCode,
    /** The State name, or the reference that was refused. Never a resolved value. */
    readonly subject: string
  ) {
    super(`${code}:${subject}`);
    this.name = "SimulationError";
  }
}

export interface SimulationFixture {
  /** Wall clock the simulation starts at. Nothing here reads the host clock. */
  readonly startedAtMs: number;
  /** Deterministic clock advance per executed State. */
  readonly tickMs?: number;
  readonly input?: JsonObject;
  readonly trigger?: JsonObject;
  /** `agent` State name → the model output to use instead of calling a provider. */
  readonly model?: Readonly<Record<string, JsonObject>>;
  /** `tool`/`compensate` State name → the result to use instead of dispatching. */
  readonly tools?: Readonly<Record<string, JsonObject>>;
  /** Waiting State name → the event, decision, or submission that resumes it. */
  readonly events?: Readonly<Record<string, JsonObject>>;
}

export interface SimulationOptions {
  /** Hard bound on executed States; a simulation never runs unbounded. */
  readonly maxSteps?: number;
}

export const DEFAULT_MAX_SIMULATION_STEPS = 500;

/** What a `tool` or `compensate` State would have dispatched, had this been a live Run. */
export interface EffectPreview {
  readonly stateName: string;
  readonly toolRef: string;
  readonly action: string;
  /** The declared Secret *reference*; simulation never resolves it to a value. */
  readonly credentialRef: string | null;
  readonly identity: { readonly principalKind: string; readonly principalId: string };
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputHash: string;
  readonly idempotencyKey: string;
  readonly dispatched: false;
  readonly secretLeased: false;
}

export type SimulationStepSource = "clock" | "evaluated" | "event" | "model" | "tool";

export interface SimulationStep {
  readonly stateName: string;
  readonly type: string;
  readonly atMs: number;
  readonly source: SimulationStepSource;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: unknown;
  readonly outputHash: string;
  readonly next: StepOutcome;
}

export interface SimulationResult {
  readonly mode: "simulation";
  readonly routine: {
    readonly slug: string;
    readonly authoredVersion: number;
    readonly digest: string;
  };
  readonly status: "completed";
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly steps: readonly SimulationStep[];
  readonly effects: readonly EffectPreview[];
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Canonical hash of the whole simulation — equal fixtures produce equal hashes. */
  readonly resultHash: string;
}

/**
 * The live capabilities a simulated Run is denied. They exist so the denial is provable and
 * loudly typed rather than implied by the absence of a port.
 */
export interface SimulationDeniedPorts {
  leaseSecret(secretRef: string): never;
  dispatchEffect(toolRef: string): never;
}

export function simulationPorts(): SimulationDeniedPorts {
  return Object.freeze({
    leaseSecret(secretRef: string): never {
      throw new SimulationError("secret_lease_denied", secretRef);
    },
    dispatchEffect(toolRef: string): never {
      throw new SimulationError("effect_dispatch_denied", toolRef);
    },
  });
}

const EVENT_STATE_TYPES: ReadonlySet<string> = new Set([
  "approval",
  "child_routine",
  "form",
  "human_task",
]);
const EFFECT_STATE_TYPES: ReadonlySet<string> = new Set(["compensate", "tool"]);
const NOT_SIMULABLE: ReadonlySet<string> = new Set(["foreach", "parallel", "repeat_until"]);

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : null;
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : null;
}

function refLabel(state: CompiledState, key: string): string {
  const ref = readRecord(state.definition, key);
  return ref === null ? "" : `${String(ref.name)}@${String(ref.version)}`;
}

function fixtureValue(
  source: Readonly<Record<string, JsonObject>> | undefined,
  state: CompiledState
): JsonObject {
  const value = source?.[state.name];
  if (value === undefined) throw new SimulationError("fixture_missing", state.name);
  return value;
}

function effectPreview(
  routine: CompiledRoutine,
  state: CompiledState,
  input: Record<string, unknown>
): EffectPreview {
  const inputHash = canonicalHash(input);
  const toolRef =
    state.type === "tool"
      ? refLabel(state, "toolRef")
      : (readString(state.definition, "targetRef") ?? "");
  return {
    stateName: state.name,
    toolRef,
    action: readString(state.definition, "action") ?? state.type,
    credentialRef: readString(state.definition, "credentialRef"),
    identity: state.identity,
    input,
    inputHash,
    idempotencyKey: canonicalHash([routine.digest, state.name, inputHash]),
    dispatched: false,
    secretLeased: false,
  };
}

/** Timer waits consume fixture time rather than a fixture event. */
function timerDurationMs(state: CompiledState): number | null {
  const waitFor = readRecord(state.definition, "waitFor");
  if (waitFor === null || waitFor.kind !== "timer") return null;
  return typeof waitFor.durationMs === "number" ? waitFor.durationMs : 0;
}

interface Executed {
  readonly source: SimulationStepSource;
  readonly output: unknown;
  readonly next: StepOutcome;
  readonly extraMs: number;
  readonly effect: EffectPreview | null;
}

function execute(
  routine: CompiledRoutine,
  state: CompiledState,
  fixture: SimulationFixture,
  scope: Readonly<Record<string, unknown>>,
  input: Record<string, unknown>
): Executed {
  if (NOT_SIMULABLE.has(state.type)) {
    throw new SimulationError("state_not_simulable", state.name);
  }

  if (state.type === "branch") {
    const { outcome } = decideBranch(state, scope);
    return { source: "evaluated", output: null, next: outcome, extraMs: 0, effect: null };
  }

  if (state.type === "agent") {
    const output = fixtureValue(fixture.model, state);
    return { source: "model", output, next: stateOutcome(state), extraMs: 0, effect: null };
  }

  if (EFFECT_STATE_TYPES.has(state.type)) {
    const output = fixtureValue(fixture.tools, state);
    return {
      source: "tool",
      output,
      next: stateOutcome(state),
      extraMs: 0,
      effect: effectPreview(routine, state, input),
    };
  }

  if (state.type === "wait") {
    const durationMs = timerDurationMs(state);
    if (durationMs !== null) {
      return {
        source: "clock",
        output: null,
        next: stateOutcome(state),
        extraMs: durationMs,
        effect: null,
      };
    }
    const output = fixtureValue(fixture.events, state);
    return { source: "event", output, next: stateOutcome(state), extraMs: 0, effect: null };
  }

  if (EVENT_STATE_TYPES.has(state.type)) {
    const output = fixtureValue(fixture.events, state);
    return { source: "event", output, next: stateOutcome(state), extraMs: 0, effect: null };
  }

  throw new SimulationError("state_not_simulable", state.name);
}

/** Execute a compiled Routine against a fixture, previewing effects instead of dispatching them. */
export function simulateRoutine(
  routine: CompiledRoutine,
  fixture: SimulationFixture,
  options: SimulationOptions = {}
): SimulationResult {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_SIMULATION_STEPS;
  const tickMs = fixture.tickMs ?? 0;

  const steps: SimulationStep[] = [];
  const effects: EffectPreview[] = [];
  const outputs: Record<string, unknown> = {};
  const stateScope: Record<string, { output: unknown }> = {};

  let atMs = fixture.startedAtMs;
  let current: string | null = routine.start;

  while (current !== null) {
    const state: CompiledState | undefined = routine.states.get(current);
    if (state === undefined) throw new SimulationError("unknown_state", current);
    if (steps.length >= maxSteps) throw new SimulationError("step_budget_exceeded", state.name);

    const scope = {
      input: fixture.input ?? {},
      trigger: fixture.trigger ?? {},
      states: stateScope,
    };
    let input: Record<string, unknown>;
    try {
      input = resolveRoutineStateInput(state, scope);
    } catch (error) {
      if (error instanceof RoutineInputResolutionError) {
        throw new SimulationError("fixture_missing", state.name);
      }
      throw error;
    }
    const executed = execute(routine, state, fixture, scope, input);

    outputs[state.name] = executed.output;
    stateScope[state.name] = { output: executed.output };
    if (executed.effect !== null) effects.push(executed.effect);
    steps.push({
      stateName: state.name,
      type: state.type,
      atMs,
      source: executed.source,
      input,
      output: executed.output,
      outputHash: canonicalHash(executed.output ?? null),
      next: executed.next,
    });

    atMs += tickMs + executed.extraMs;
    current = executed.next.kind === "transition" ? executed.next.target : null;
  }

  const result = {
    mode: "simulation" as const,
    routine: {
      slug: routine.slug,
      authoredVersion: routine.authoredVersion,
      digest: routine.digest,
    },
    status: "completed" as const,
    startedAtMs: fixture.startedAtMs,
    endedAtMs: atMs,
    steps: Object.freeze(steps),
    effects: Object.freeze(effects),
    outputs: Object.freeze(outputs),
  };

  return Object.freeze({
    ...result,
    resultHash: canonicalHash({
      digest: routine.digest,
      steps: steps.map((step) => ({ stateName: step.stateName, outputHash: step.outputHash })),
      effects: effects.map((effect) => effect.idempotencyKey),
      endedAtMs: atMs,
    }),
  });
}
