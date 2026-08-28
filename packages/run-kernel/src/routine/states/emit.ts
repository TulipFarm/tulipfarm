import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { RoutineStepError } from "./step";

/**
 * The announcement step: an `emit` State raises an internal event and continues.
 *
 * It never waits. A Routine that needs the callee's answer calls `child_routine`; `emit` exists
 * for the fan-out case, where the emitter neither knows nor cares who listens. Whether any
 * Trigger bound the event is therefore not the emitter's business, and does not settle it.
 */

/** The version an `emit` State announces when its author did not pin one. */
export const DEFAULT_EMITTED_EVENT_VERSION = 1;

export interface EmittedEvent {
  readonly eventType: string;
  readonly eventVersion: number;
  /** The resolved `input` map — the event payload a bound Trigger reads as `trigger.payload`. */
  readonly data: Record<string, unknown>;
}

/** Resolve what this `emit` State announces, against the Context built so far. */
export function planEmit(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): EmittedEvent {
  if (state.definition.type !== "emit") {
    throw new RoutineStepError("state_cannot_progress", state.name);
  }
  return {
    eventType: state.definition.event.type,
    eventVersion: state.definition.event.version ?? DEFAULT_EMITTED_EVENT_VERSION,
    data: resolveRoutineStateInput(state, scope),
  };
}
