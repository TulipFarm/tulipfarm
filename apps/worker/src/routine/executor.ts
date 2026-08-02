import {
  type ArtifactService,
  type CompiledExpression,
  type CompiledRoutine,
  type CompiledState,
  compileRoutine,
  decideBranch,
  type IdentityCeiling,
  RoutineInputResolutionError,
  type RoutineStateScheduler,
  RoutineStepError,
  RUN_EXECUTOR_PRINCIPAL_REF,
  resolveRoutineStateInput,
  type StateStatus,
} from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { PersistedRun, PersistedState, RunStore } from "@tulipfarm/storage";
import type { StateTransitionPort } from "../agent-state";
import type { RunExecutor } from "../executors";
import type { WorkerRoutineDefinitionLoader } from "./definition-loader";

export type RoutineExecutionRefusalCode =
  | "invalid_request_artifact"
  | "missing_state"
  | "unsupported_context"
  | "unsupported_state";

/** Payload-safe refusal for a Routine capability this executor does not yet own. */
export class RoutineExecutionRefusal extends Error {
  readonly name = "RoutineExecutionRefusal";

  constructor(
    readonly code: RoutineExecutionRefusalCode,
    readonly state: string
  ) {
    super(`${code}:${state}`);
  }
}

interface RoutineArtifactReader {
  read: ArtifactService["read"];
}

interface RoutineRunStateReader {
  listStates: Pick<RunStore, "listStates">["listStates"];
}

interface RoutineExecutorOptions {
  readonly definitions: Pick<WorkerRoutineDefinitionLoader, "load">;
  readonly artifacts: RoutineArtifactReader;
  readonly runs: RoutineRunStateReader;
  readonly scheduler: Pick<RoutineStateScheduler, "schedule">;
  readonly transitions: StateTransitionPort;
  readonly now?: () => Date;
  readonly identityCeiling?: (run: PersistedRun) => IdentityCeiling;
}

interface ManualRoutineRequest {
  readonly slug: string;
  readonly inputs: Record<string, unknown>;
}

const CLAIM_PATH: readonly StateStatus[] = ["ready", "claimed", "running"];
const SUPPORTED_ROOTS: ReadonlySet<string> = new Set(["input", "states"]);

function defaultIdentityCeiling(run: PersistedRun): IdentityCeiling {
  return {
    principalKind: run.identity.effectiveSubject.kind,
    principalId: run.identity.effectiveSubject.id,
    grants: [],
    maxRiskClass: "low",
  };
}

function artifactId(payloadRef: unknown, state: string): string {
  if (typeof payloadRef !== "string" || !payloadRef.startsWith("artifact:")) {
    throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  }
  const id = payloadRef.slice("artifact:".length);
  if (id.length === 0) throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  return id;
}

function manualRequest(content: Record<string, unknown>, state: string): ManualRoutineRequest {
  const { slug, inputs } = content;
  if (
    typeof slug !== "string" ||
    typeof inputs !== "object" ||
    inputs === null ||
    Array.isArray(inputs)
  ) {
    throw new RoutineExecutionRefusal("invalid_request_artifact", state);
  }
  return { slug, inputs: inputs as Record<string, unknown> };
}

function assertSupportedExpression(expression: CompiledExpression, state: string): void {
  for (const reference of expression.references) {
    const [root] = reference.split(".");
    if (!SUPPORTED_ROOTS.has(root ?? "")) {
      throw new RoutineExecutionRefusal("unsupported_context", state);
    }
  }
}

function assertSupportedState(state: CompiledState): void {
  if (state.type !== "branch") {
    throw new RoutineExecutionRefusal("unsupported_state", state.name);
  }
  for (const condition of state.conditions) {
    assertSupportedExpression(condition.condition, state.name);
  }
}

function assertSupportedInput(state: CompiledState): void {
  for (const mapping of state.inputs) {
    if (mapping.expression !== null) assertSupportedExpression(mapping.expression, state.name);
  }
}

function scopeFor(
  input: Record<string, unknown>,
  outputs: Readonly<Record<string, { readonly output: unknown }>>
): Readonly<Record<string, unknown>> {
  return { input, states: outputs };
}

function nextState(
  routine: CompiledRoutine,
  current: CompiledState,
  target: string
): CompiledState {
  const next = routine.states.get(target);
  if (next === undefined) throw new RoutineExecutionRefusal("missing_state", current.name);
  return next;
}

function progressionFrom(status: PersistedState["status"]): readonly StateStatus[] | null {
  const index = CLAIM_PATH.indexOf(status as StateStatus);
  if (status === "pending") return CLAIM_PATH;
  if (index >= 0) return CLAIM_PATH.slice(index + 1);
  return null;
}

/**
 * Worker-owned executor for the first deterministic Routine capability: pure `branch` graphs.
 *
 * Successors are persisted before their predecessor succeeds. A crash in between therefore
 * replays the same branch decision into `ensureState`, which returns the one existing State rather
 * than duplicating work. Every other State type is parked without dispatching an effect.
 */
export function createRoutineExecutor(options: RoutineExecutorOptions): RunExecutor {
  const now = options.now ?? (() => new Date());
  const ceiling = options.identityCeiling ?? defaultIdentityCeiling;

  return async (run): Promise<"succeeded" | "failed" | "needs_reconciliation" | "cancelled"> => {
    const loaded = await options.definitions.load(run);
    const routine = compileRoutine(loaded.document, { identityCeiling: ceiling(run) });
    const persisted = new Map(
      (await options.runs.listStates(run.businessId, run.id)).map((state) => [state.key, state])
    );
    const start = persisted.get(routine.start);
    if (start === undefined) return "needs_reconciliation";

    const requestArtifact = await options.artifacts.read({
      businessId: run.businessId,
      artifactId: artifactId(start.resolvedInput.payloadRef, start.key),
      reader: RUN_EXECUTOR_PRINCIPAL_REF,
      allowedClassifications: [],
      now: now(),
    });
    if (requestArtifact.schemaRef !== MANUAL_REQUEST_SCHEMA_REF) {
      return "needs_reconciliation";
    }
    const request = manualRequest(requestArtifact.content, start.key);
    if (request.slug !== routine.slug) return "needs_reconciliation";

    const outputs: Record<string, { readonly output: unknown }> = {};
    let currentName = routine.start;

    for (let step = 0; step <= routine.order.length; step += 1) {
      const state = routine.states.get(currentName);
      const row = persisted.get(currentName);
      if (state === undefined || row === undefined) return "needs_reconciliation";

      if (row.status === "failed") return "failed";
      if (row.status === "cancelled" || row.status === "cancelling") return "cancelled";
      if (row.status === "needs_reconciliation") return "needs_reconciliation";
      if (row.status === "waiting" || row.status === "skipped") return "needs_reconciliation";

      const scope = scopeFor(request.inputs, outputs);
      if (row.status === "succeeded") {
        outputs[state.name] = { output: null };
        try {
          assertSupportedState(state);
          const { outcome } = decideBranch(state, scope);
          if (outcome.kind === "end") return "succeeded";
          if (!persisted.has(outcome.target)) return "needs_reconciliation";
          currentName = outcome.target;
          continue;
        } catch (error) {
          if (error instanceof RoutineExecutionRefusal || error instanceof RoutineStepError) {
            return "needs_reconciliation";
          }
          throw error;
        }
      }

      const progression = progressionFrom(row.status);
      if (progression === null) return "needs_reconciliation";
      let from: StateStatus = row.status;
      for (const to of progression) {
        await options.transitions.transition({
          businessId: run.businessId,
          runId: run.id,
          stateKey: state.name,
          from,
          to,
        });
        from = to;
      }

      try {
        assertSupportedState(state);
        const { outcome } = decideBranch(state, scope);
        if (outcome.kind === "transition") {
          const target = nextState(routine, state, outcome.target);
          assertSupportedInput(target);
          const targetScope = scopeFor(request.inputs, {
            ...outputs,
            [state.name]: { output: null },
          });
          const scheduled = await options.scheduler.schedule({
            run,
            stateKey: target.name,
            definitionStateKey: target.name,
            resolvedInput: resolveRoutineStateInput(target, targetScope),
            createdAt: now().toISOString(),
          });
          persisted.set(target.name, scheduled.state);
        }

        await options.transitions.transition({
          businessId: run.businessId,
          runId: run.id,
          stateKey: state.name,
          from: "running",
          to: "succeeded",
        });
        outputs[state.name] = { output: null };
        if (outcome.kind === "end") return "succeeded";
        currentName = outcome.target;
      } catch (error) {
        if (
          !(error instanceof RoutineExecutionRefusal) &&
          !(error instanceof RoutineInputResolutionError) &&
          !(error instanceof RoutineStepError)
        ) {
          throw error;
        }
        await options.transitions.transition({
          businessId: run.businessId,
          runId: run.id,
          stateKey: state.name,
          from: "running",
          to: "needs_reconciliation",
          reason: `routine:${error.code}`,
        });
        return "needs_reconciliation";
      }
    }

    return "needs_reconciliation";
  };
}
