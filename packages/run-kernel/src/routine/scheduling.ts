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

export function routineStateDefinitionRef(bundle: RunBundle, stateKey: string): string {
  return [
    `bundle:${encodeURIComponent(bundle.digest)}`,
    `routines/${encodeURIComponent(bundle.routineId)}@${encodeURIComponent(bundle.routineVersion)}`,
    `states/${encodeURIComponent(stateKey)}`,
  ].join("/");
}

/**
 * Occurrence keys include labels from pinned collections or authored branch lists, never process
 * counters, so replay addresses the same rows.
 */
export function routineOccurrenceKey(parentKey: string, unit: string, stateKey: string): string {
  return `${parentKey}#${unit}/${stateKey}`;
}

/** Wait ids derive from Run and occurrence key so wait registration is replay-safe. */
export function routineWaitId(runId: string, stateKey: string): string {
  return derivedId("routine-wait", runId, stateKey);
}

/** Effect ids derive from Run and occurrence key so effect reservation is replay-safe. */
export function routineEffectId(runId: string, stateKey: string): string {
  return derivedId("routine-effect", runId, stateKey);
}

/** A `uuid` column needs a legal uuid, so the digest is dressed as an RFC 4122 version 4 value. */
function derivedId(purpose: string, runId: string, stateKey: string): string {
  const digest = createHash("sha256").update(`${purpose}:${runId}:${stateKey}`).digest("hex");
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

export interface RoutineStateScheduleStore {
  ensureState(input: EnsureStateInput): Promise<EnsureStateResult>;
}

export interface ScheduleRoutineStateInput {
  readonly run: PersistedRun;
  readonly stateKey: string;
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
