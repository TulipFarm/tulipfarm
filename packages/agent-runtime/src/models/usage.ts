/**
 * Model usage evidence (SPEC §10 step 7, §17). Every model attempt persists token, cost, latency,
 * and routing facts so budgets and audits read the same durable record. Evidence carries no
 * prompt, Message, Context, or model output content — protected contents travel as authorized
 * Artifacts, never as inline evidence.
 */

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

/** Collects usage in memory. Tests and warm caches only; never an authoritative ledger. */
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
