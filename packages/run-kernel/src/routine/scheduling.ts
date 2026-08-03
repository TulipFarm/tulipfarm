import { createHash } from "node:crypto";
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

/**
 * Durable key for one occurrence of an authored State inside a bounded fan-out or loop.
 *
 * A `foreach` item, a `parallel` branch, and a `repeat_until` iteration each execute the same
 * authored States more than once, so the authored name cannot be the durable key. The unit label
 * is part of the key and derived from the pinned collection or the authored branch list, never
 * from a counter this process holds: replaying the same fan-out therefore addresses the same rows
 * instead of scheduling a second copy of work already done.
 */
export function routineOccurrenceKey(parentKey: string, unit: string, stateKey: string): string {
  return `${parentKey}#${unit}/${stateKey}`;
}

/**
 * Deterministic wait id for one State occurrence. `run_waits.id` is a primary key, so deriving it
 * from the Run and the occurrence key is what makes registering a wait replay-safe: a worker that
 * died between creating the wait and parking the State finds the wait it already created rather
 * than opening a second timer against the same State.
 */
export function routineWaitId(runId: string, stateKey: string): string {
  const digest = createHash("sha256").update(`routine-wait:${runId}:${stateKey}`).digest("hex");
  // RFC 4122 version 4 / variant 10 bits, so the value is a legal uuid for the `uuid` column.
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
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
