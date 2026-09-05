import { randomUUID } from "node:crypto";
import type { LlmCallRecord, SpendSink, TurnRecord } from "@tulipfarm/turn-executor";
import type { Queryable } from "./db";

export type { LlmCallRecord, SpendSink, TurnRecord } from "@tulipfarm/turn-executor";

/** Drops undefined keys so the stored attributes stay compact rather than full of nulls. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Writes the Worker's spend straight to `obs_event`.
 *
 * The observability spine had a complete subscriber, metrics and OTLP export hanging off
 * `llm.step_finished`, and nothing in production ever emitted it: the turn loop moved to this
 * process while the emitter stayed behind as an in-process `EventEmitter` in the API, so every
 * dashboard read `$0.00 / 0 tokens / 0 turns` — which is indistinguishable from a quiet week,
 * and is why it went unnoticed.
 *
 * Writing rows directly is deliberate over posting them back to the API. The Worker already owns
 * a pool against the same database, so the write is durable at the point it is made and does not
 * depend on the API being reachable at the moment a turn happens to finish.
 */
export class PgSpendSink implements SpendSink {
  constructor(
    private readonly db: Queryable,
    private readonly log?: { warn(obj: unknown, msg?: string): void }
  ) {}

  recordLlmCall(record: LlmCallRecord): void {
    const usage = record.usage;
    this.insert({
      type: "llm_call",
      agentId: record.agentId,
      conversationId: record.conversationId,
      model: record.model,
      provider: record.provider,
      tier: record.tier,
      tokensIn: usage?.inputTokens,
      tokensOut: usage?.outputTokens,
      // Null, not zero: an unpriceable call is not a free one, and the dashboard counts these
      // separately so an operator can see how much of their spend is unaccounted for.
      costUsd: usage?.costBasis === "priced" ? usage.costUsd : undefined,
      durationMs: record.durationMs,
      status: record.status,
      subjectKind: record.principal?.kind,
      subjectId: record.principal?.id,
      attributes: compact({
        cacheRead: usage?.cacheReadTokens,
        cacheWrite: usage?.cacheWriteTokens,
        reasoning: usage?.reasoningTokens,
        costBasis: usage?.costBasis,
        runId: record.runId,
        turnId: record.turnId,
      }),
    });
  }

  recordTurn(record: TurnRecord): void {
    this.insert({
      type: "turn",
      agentId: record.agentId,
      conversationId: record.conversationId,
      durationMs: record.durationMs,
      status: record.status,
      subjectKind: record.principal?.kind,
      subjectId: record.principal?.id,
      attributes: compact({ runId: record.runId, turnId: record.turnId }),
    });
  }

  private insert(row: {
    type: string;
    agentId?: string;
    conversationId?: string;
    model?: string;
    provider?: string;
    tier?: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    durationMs?: number;
    status: string;
    subjectKind?: string;
    subjectId?: string;
    attributes: Record<string, unknown>;
  }): void {
    const now = new Date();
    this.db
      .query(
        `INSERT INTO obs_event
           (id, ts, type, agent_id, conversation_id, model, provider, tier,
            tokens_in, tokens_out, cost_usd, duration_ms, status, tool_name, subject_kind,
            subject_id, attributes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14, $15, $16::jsonb, $17)`,
        [
          randomUUID(),
          now,
          row.type,
          row.agentId ?? null,
          row.conversationId ?? null,
          row.model ?? null,
          row.provider ?? null,
          row.tier ?? null,
          row.tokensIn ?? null,
          row.tokensOut ?? null,
          row.costUsd ?? null,
          row.durationMs ?? null,
          row.status,
          row.subjectKind ?? null,
          row.subjectId ?? null,
          JSON.stringify(row.attributes),
          now,
        ]
      )
      .catch((error: unknown) => {
        this.log?.warn(
          {
            event: "spend_sink.write_failed",
            type: row.type,
            error: error instanceof Error ? error.message : String(error),
          },
          "failed to record spend"
        );
      });
  }
}
