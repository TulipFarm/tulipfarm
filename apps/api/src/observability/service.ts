import { randomUUID } from "node:crypto";
import type {
  ObsEventRow,
  ObsEventType,
  ObsRepo,
  ObsSummary,
  RecentTurn,
  TraceEvent,
} from "./repo";

export type SummaryRange = "24h" | "7d" | "30d";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES: Record<SummaryRange, { ms: number; bucket: "hour" | "day" }> = {
  "24h": { ms: DAY_MS, bucket: "hour" },
  "7d": { ms: 7 * DAY_MS, bucket: "day" },
  "30d": { ms: 30 * DAY_MS, bucket: "day" },
};

export function isSummaryRange(v: unknown): v is SummaryRange {
  return v === "24h" || v === "7d" || v === "30d";
}

/**
 * Input to `ObservabilityService.record`. Only `type` is required; every other field defaults to
 * null / `{}`. `ts` defaults to now — pass it when the event time differs from write time.
 */
export interface RecordObsInput {
  type: ObsEventType;
  ts?: Date;
  agentId?: string | null;
  conversationId?: string | null;
  model?: string | null;
  provider?: string | null;
  tier?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  status?: string | null;
  toolName?: string | null;
  attributes?: Record<string, unknown>;
}

/** Best-effort AI observability write path; failures must not affect chat turns. */
export class ObservabilityService {
  constructor(private readonly repo: ObsRepo) {}

  async record(input: RecordObsInput): Promise<void> {
    try {
      const now = new Date();
      const row: ObsEventRow = {
        _id: randomUUID(),
        ts: input.ts ?? now,
        type: input.type,
        agentId: input.agentId ?? null,
        conversationId: input.conversationId ?? null,
        model: input.model ?? null,
        provider: input.provider ?? null,
        tier: input.tier ?? null,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        costUsd: input.costUsd ?? null,
        durationMs: input.durationMs ?? null,
        status: input.status ?? null,
        toolName: input.toolName ?? null,
        attributes: input.attributes ?? {},
        createdAt: now,
      };
      await this.repo.insert(row);
    } catch (err) {
      console.error(
        `[observability] record failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Pre-aggregated dashboard data over the trailing window. */
  summary(range: SummaryRange): Promise<ObsSummary> {
    const { ms, bucket } = RANGES[range];
    return this.repo.summarize({ since: new Date(Date.now() - ms), bucket });
  }

  /** Newest-first recent turns (drill-down entry points). */
  recentTurns(limit = 25): Promise<RecentTurn[]> {
    return this.repo.recentTurns(Math.min(Math.max(limit, 1), 100));
  }

  /** A conversation's event timeline (trace drill-down). */
  trace(conversationId: string): Promise<TraceEvent[]> {
    return this.repo.traceByConversation(conversationId);
  }
}
