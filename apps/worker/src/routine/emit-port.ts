import type { InternalApiClient } from "../internal/client";

/**
 * The emission surface. The Worker cannot mint a Run, so it announces the event and the API
 * answers with whatever Trigger bound it — or with nothing, which is not a fault.
 */

export type EmitOutcome = "started" | "duplicate" | "no_match" | "ambiguous" | "rejected";

export interface EmitRecord {
  readonly eventId: string;
  readonly outcome: EmitOutcome;
  readonly triggerSlug?: string;
  readonly runId?: string;
}

export interface EmitEventInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly data: Record<string, unknown>;
}

export interface EmitPort {
  /**
   * Announce this State occurrence's event.
   *
   * Idempotent by occurrence: a Worker that died after announcing but before settling the State
   * re-announces the same event id, which the Run gateway deduplicates.
   */
  emit(input: EmitEventInput): Promise<EmitRecord>;
}

/** The `/api/v1/internal/runs/:runId/emissions` implementation of the port. */
export class HttpEmitPort implements EmitPort {
  constructor(private readonly client: InternalApiClient) {}

  async emit(input: EmitEventInput): Promise<EmitRecord> {
    return this.client.require<EmitRecord>(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(input.runId)}/emissions`,
      {
        stateKey: input.stateKey,
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        data: input.data,
      }
    );
  }
}
