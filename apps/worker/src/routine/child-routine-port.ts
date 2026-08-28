import type { InternalApiClient } from "../internal/client";

/**
 * The child-Routine surface. The Worker cannot mint a Run, so it names the Routine and the API
 * answers with the child Run it started — and, in `wait` mode, has already parked the caller on.
 */

export type ChildRoutineStatus = "pending" | "succeeded" | "failed" | "cancelled" | "expired";

export interface ChildRoutineRecord {
  readonly childRunId: string;
  readonly status: ChildRoutineStatus;
  readonly waitId: string | null;
}

export interface StartChildRoutineInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly stateName: string;
  readonly routineRef: { readonly name: string; readonly version: string };
  readonly mode: "wait" | "detach";
  readonly input: Record<string, unknown>;
  /** Required in `wait` mode, where it bounds how long the caller may stay parked. */
  readonly deadlineMs?: number;
}

export interface ChildRoutinePort {
  /**
   * Start the child this State occurrence calls, or return the one it already called.
   *
   * Idempotent by occurrence: a worker that died between starting the child and parking the State
   * adopts its own child on replay rather than running the callee twice.
   */
  start(input: StartChildRoutineInput): Promise<ChildRoutineRecord>;

  /** The child this State occurrence is parked on, and what it has come to. */
  find(input: {
    businessId: string;
    runId: string;
    stateKey: string;
  }): Promise<ChildRoutineRecord | undefined>;
}

/** The `/api/v1/internal/runs/:runId/child-routines` implementation of the port. */
export class HttpChildRoutinePort implements ChildRoutinePort {
  constructor(private readonly client: InternalApiClient) {}

  async start(input: StartChildRoutineInput): Promise<ChildRoutineRecord> {
    return this.client.require<ChildRoutineRecord>(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(input.runId)}/child-routines`,
      {
        stateKey: input.stateKey,
        stateName: input.stateName,
        routineRef: input.routineRef,
        mode: input.mode,
        input: input.input,
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      }
    );
  }

  async find(input: {
    businessId: string;
    runId: string;
    stateKey: string;
  }): Promise<ChildRoutineRecord | undefined> {
    // Only `204` means this State called nothing; `404` is a dead Run and must stay an error.
    return this.client.find<ChildRoutineRecord>(
      "GET",
      `/api/v1/internal/runs/${encodeURIComponent(input.runId)}/child-routines?stateKey=${encodeURIComponent(input.stateKey)}`,
      [204]
    );
  }
}
