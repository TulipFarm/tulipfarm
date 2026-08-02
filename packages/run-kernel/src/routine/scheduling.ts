import type {
  EnsureStateInput,
  EnsureStateResult,
  PersistedRun,
  RunBundle,
} from "@tulipfarm/storage";

export type RoutineStateScheduleErrorCode = "invalid_state_identity" | "non_routine_run";

/** Payload-safe refusal to schedule a State outside its Run's exact Routine identity. */
export class RoutineStateScheduleError extends Error {
  readonly name = "RoutineStateScheduleError";

  constructor(
    readonly code: RoutineStateScheduleErrorCode,
    readonly runId: string
  ) {
    super(`${code}:${runId}`);
  }
}

/** Stable reference to one authored State inside an immutable Routine bundle. */
export function routineStateDefinitionRef(bundle: RunBundle, stateKey: string): string {
  return [
    `bundle:${encodeURIComponent(bundle.digest)}`,
    `routines/${encodeURIComponent(bundle.routineId)}@${encodeURIComponent(bundle.routineVersion)}`,
    `states/${encodeURIComponent(stateKey)}`,
  ].join("/");
}

/** Narrow surface the scheduler needs; `@tulipfarm/storage`'s `RunStore` satisfies it. */
export interface RoutineStateScheduleStore {
  ensureState(input: EnsureStateInput): Promise<EnsureStateResult>;
}

export interface ScheduleRoutineStateInput {
  readonly run: PersistedRun;
  /** Durable State occurrence key. It may differ from the authored key for bounded fan-out. */
  readonly stateKey: string;
  /** State name in the pinned Routine definition. */
  readonly definitionStateKey: string;
  readonly resolvedInput: Record<string, unknown>;
  readonly createdAt: string;
}

/** Persist-first, replay-safe scheduling for later States in a Routine Run. */
export class RoutineStateScheduler {
  constructor(private readonly store: RoutineStateScheduleStore) {}

  async schedule(input: ScheduleRoutineStateInput): Promise<EnsureStateResult> {
    if (input.run.source !== "routine") {
      throw new RoutineStateScheduleError("non_routine_run", input.run.id);
    }
    const { bundle } = input.run;
    if (
      input.stateKey.length === 0 ||
      input.definitionStateKey.length === 0 ||
      bundle.digest.length === 0 ||
      bundle.routineId.length === 0 ||
      bundle.routineVersion.length === 0
    ) {
      throw new RoutineStateScheduleError("invalid_state_identity", input.run.id);
    }

    return this.store.ensureState({
      businessId: input.run.businessId,
      runId: input.run.id,
      key: input.stateKey,
      definitionRef: routineStateDefinitionRef(bundle, input.definitionStateKey),
      resolvedInput: input.resolvedInput,
      createdAt: input.createdAt,
    });
  }
}
