/** Durable usage evidence carries routing facts, never prompt or model content. */

export type ModelUsageOutcome =
  | "succeeded"
  | "provider_error"
  | "provider_unavailable"
  | "budget_exceeded"
  | "latency_exceeded";

export interface ModelUsageEvent {
  readonly requestId: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: string;
  /** 1-based position in the fallback chain, so a retry is distinguishable from a fallback. */
  readonly attempt: number;
  readonly outcome: ModelUsageOutcome;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly cacheAllowed: boolean;
  readonly providerRequestId?: string;
  readonly occurredAt: Date;
}

export interface ModelUsageSink {
  record(event: ModelUsageEvent): Promise<void>;
}

export class InMemoryModelUsageSink implements ModelUsageSink {
  readonly events: ModelUsageEvent[] = [];

  async record(event: ModelUsageEvent): Promise<void> {
    this.events.push(event);
  }
}

export function totalModelCostUsd(events: readonly ModelUsageEvent[]): number {
  return events.reduce((total, event) => total + (event.costUsd ?? 0), 0);
}

export function totalModelTokens(events: readonly ModelUsageEvent[]): number {
  return events.reduce((total, event) => total + event.inputTokens + event.outputTokens, 0);
}
