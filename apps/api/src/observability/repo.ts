import type { Queryable } from "../db";

export type ObsEventType = "llm_call" | "tool_call" | "turn" | "job";
/** Per-type outcome: llm_call ok|error|fallback|timeout; tool_call ok|error; turn ok|error|blocked; job ok|error. */
export type ObsStatus = "ok" | "error" | "fallback" | "blocked" | "timeout";

/**
 * One row in the AI observability event spine (`obs_event`). Append-only: written at event time by
 * `ObservabilityService.record()` and never updated. Hot aggregate/filter fields are typed columns;
 * the long tail (token cache breakdown, error codes, job names) rides in `attributes` jsonb.
 * `costUsd` is frozen at write (NULL ⇒ the served model was unpriced). Cost/token totals are summed
 * from `type='llm_call'` rows only — `turn` rows carry display rollups and must not be re-summed.
 */
export interface ObsEventRow {
  _id: string;
  ts: Date;
  type: ObsEventType;
  agentId: string | null;
  conversationId: string | null;
  model: string | null;
  provider: string | null;
  tier: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  status: string | null;
  toolName: string | null;
  attributes: Record<string, unknown>;
  createdAt: Date;
}

/** Pre-aggregated dashboard data. Cost/token totals come from `llm_call` rows only (counting rule). */
export interface ObsSummary {
  totals: { costUsd: number; tokens: number; turns: number; unpricedCalls: number };
  series: Array<{ bucket: string; costUsd: number; tokens: number }>;
  byAgent: Array<{ agentId: string; costUsd: number }>;
  byModel: Array<{ model: string; costUsd: number; calls: number; unpriced: boolean }>;
  /** Reliability lens: turn/tool/llm error + fallback counts and p95 step latency over the window. */
  reliability: {
    turns: number;
    turnErrors: number;
    llmCalls: number;
    llmErrors: number;
    fallbacks: number;
    toolCalls: number;
    toolErrors: number;
    p95DurationMs: number;
  };
}

export interface SummarizeOpts {
  since: Date;
  /** date_trunc granularity for the time series — validated to these literals (no injection). */
  bucket: "hour" | "day";
}

/** A recent chat turn for the trace list (drill-down entry point). */
export interface RecentTurn {
  conversationId: string | null;
  agentId: string | null;
  status: string | null;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  ts: string;
}

/** One event in a conversation's trace timeline (llm_call / tool_call / turn), oldest-first. */
export interface TraceEvent {
  type: ObsEventType;
  ts: string;
  agentId: string | null;
  model: string | null;
  provider: string | null;
  tier: string | null;
  status: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  toolName: string | null;
  attributes: Record<string, unknown>;
}

export interface ObsRepo {
  insert(row: ObsEventRow): Promise<void>;
  summarize(opts: SummarizeOpts): Promise<ObsSummary>;
  /** Prune rows older than the cutoff (retention). Returns the number deleted. */
  deleteOlderThan(cutoff: Date): Promise<number>;
  /** Newest-first recent turns (drill-down list). */
  recentTurns(limit: number): Promise<RecentTurn[]>;
  /** A conversation's full event timeline, oldest-first (trace drill-down). */
  traceByConversation(conversationId: string): Promise<TraceEvent[]>;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export class PgObsRepo implements ObsRepo {
  constructor(private readonly q: Queryable) {}

  async insert(row: ObsEventRow): Promise<void> {
    await this.q.query(
      `INSERT INTO obs_event
         (id, ts, type, agent_id, conversation_id, model, provider, tier,
          tokens_in, tokens_out, cost_usd, duration_ms, status, tool_name, attributes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)`,
      [
        row._id,
        row.ts,
        row.type,
        row.agentId,
        row.conversationId,
        row.model,
        row.provider,
        row.tier,
        row.tokensIn,
        row.tokensOut,
        row.costUsd,
        row.durationMs,
        row.status,
        row.toolName,
        JSON.stringify(row.attributes),
        row.createdAt,
      ]
    );
  }

  async summarize({ since, bucket }: SummarizeOpts): Promise<ObsSummary> {
    // Cost/token totals + unpriced count from llm_call rows; turns from turn rows. FILTER keeps it
    // to one scan. `tokens` = input + output. cost_usd is numeric (returned as string) → coerced.
    const totalsQ = this.q.query(
      `SELECT
         COALESCE(SUM(cost_usd) FILTER (WHERE type = 'llm_call'), 0) AS cost,
         COALESCE(SUM((COALESCE(tokens_in,0) + COALESCE(tokens_out,0))) FILTER (WHERE type = 'llm_call'), 0) AS tokens,
         COUNT(*) FILTER (WHERE type = 'turn') AS turns,
         COUNT(*) FILTER (WHERE type = 'llm_call' AND cost_usd IS NULL) AS unpriced
       FROM obs_event WHERE ts >= $1`,
      [since]
    );
    // date_trunc's unit is a bound param (validated literal) — safe from injection.
    const seriesQ = this.q.query(
      `SELECT date_trunc($2, ts) AS bucket,
         COALESCE(SUM(cost_usd), 0) AS cost,
         COALESCE(SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)), 0) AS tokens
       FROM obs_event WHERE type = 'llm_call' AND ts >= $1
       GROUP BY 1 ORDER BY 1`,
      [since, bucket]
    );
    const byAgentQ = this.q.query(
      `SELECT COALESCE(agent_id, '(unknown)') AS agent, COALESCE(SUM(cost_usd), 0) AS cost
       FROM obs_event WHERE type = 'llm_call' AND ts >= $1
       GROUP BY 1 ORDER BY cost DESC, agent ASC LIMIT 20`,
      [since]
    );
    const byModelQ = this.q.query(
      `SELECT COALESCE(model, '(unknown)') AS model, COALESCE(SUM(cost_usd), 0) AS cost,
              COUNT(*) AS calls, bool_and(cost_usd IS NULL) AS unpriced
       FROM obs_event WHERE type = 'llm_call' AND ts >= $1
       GROUP BY 1 ORDER BY cost DESC, calls DESC, model ASC LIMIT 20`,
      [since]
    );
    const reliabilityQ = this.q.query(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'turn') AS turns,
         COUNT(*) FILTER (WHERE type = 'turn' AND status = 'error') AS turn_errors,
         COUNT(*) FILTER (WHERE type = 'llm_call') AS llm_calls,
         COUNT(*) FILTER (WHERE type = 'llm_call' AND status = 'error') AS llm_errors,
         COUNT(*) FILTER (WHERE type = 'llm_call' AND status = 'fallback') AS fallbacks,
         COUNT(*) FILTER (WHERE type = 'tool_call') AS tool_calls,
         COUNT(*) FILTER (WHERE type = 'tool_call' AND status = 'error') AS tool_errors,
         COALESCE(
           percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE type = 'llm_call' AND duration_ms IS NOT NULL),
           0
         ) AS p95
       FROM obs_event WHERE ts >= $1`,
      [since]
    );

    const [totals, series, byAgent, byModel, reliability] = await Promise.all([
      totalsQ,
      seriesQ,
      byAgentQ,
      byModelQ,
      reliabilityQ,
    ]);
    const rel = reliability.rows[0] as Record<string, unknown>;

    const t = totals.rows[0] as Record<string, unknown>;
    return {
      totals: {
        costUsd: num(t.cost),
        tokens: num(t.tokens),
        turns: num(t.turns),
        unpricedCalls: num(t.unpriced),
      },
      series: series.rows.map((r) => {
        const row = r as Record<string, unknown>;
        const b = row.bucket;
        return {
          bucket: b instanceof Date ? b.toISOString() : String(b),
          costUsd: num(row.cost),
          tokens: num(row.tokens),
        };
      }),
      byAgent: byAgent.rows.map((r) => {
        const row = r as Record<string, unknown>;
        return { agentId: String(row.agent), costUsd: num(row.cost) };
      }),
      byModel: byModel.rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          model: String(row.model),
          costUsd: num(row.cost),
          calls: num(row.calls),
          unpriced: row.unpriced === true,
        };
      }),
      reliability: {
        turns: num(rel.turns),
        turnErrors: num(rel.turn_errors),
        llmCalls: num(rel.llm_calls),
        llmErrors: num(rel.llm_errors),
        fallbacks: num(rel.fallbacks),
        toolCalls: num(rel.tool_calls),
        toolErrors: num(rel.tool_errors),
        p95DurationMs: Math.round(num(rel.p95)),
      },
    };
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    // RETURNING id so the deleted count works across the Queryable contract (pg + PGlite), which
    // exposes only `rows`, not `rowCount`.
    const res = await this.q.query("DELETE FROM obs_event WHERE ts < $1 RETURNING id", [cutoff]);
    return res.rows.length;
  }

  async recentTurns(limit: number): Promise<RecentTurn[]> {
    const { rows } = await this.q.query(
      `SELECT conversation_id, agent_id, status, tokens_in, tokens_out, attributes, ts
       FROM obs_event WHERE type = 'turn' ORDER BY ts DESC LIMIT $1`,
      [limit]
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const attrs = (row.attributes as Record<string, unknown> | null) ?? {};
      return {
        conversationId: (row.conversation_id as string | null) ?? null,
        agentId: (row.agent_id as string | null) ?? null,
        status: (row.status as string | null) ?? null,
        tokensIn: num(row.tokens_in),
        tokensOut: num(row.tokens_out),
        steps: num(attrs.steps),
        ts: iso(row.ts),
      };
    });
  }

  async traceByConversation(conversationId: string): Promise<TraceEvent[]> {
    const { rows } = await this.q.query(
      `SELECT type, ts, agent_id, model, provider, tier, status, tokens_in, tokens_out,
              cost_usd, duration_ms, tool_name, attributes
       FROM obs_event WHERE conversation_id = $1 ORDER BY ts ASC`,
      [conversationId]
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        type: row.type as ObsEventType,
        ts: iso(row.ts),
        agentId: (row.agent_id as string | null) ?? null,
        model: (row.model as string | null) ?? null,
        provider: (row.provider as string | null) ?? null,
        tier: (row.tier as string | null) ?? null,
        status: (row.status as string | null) ?? null,
        tokensIn: numOrNull(row.tokens_in),
        tokensOut: numOrNull(row.tokens_out),
        costUsd: numOrNull(row.cost_usd),
        durationMs: numOrNull(row.duration_ms),
        toolName: (row.tool_name as string | null) ?? null,
        attributes: (row.attributes as Record<string, unknown> | null) ?? {},
      };
    });
  }
}
