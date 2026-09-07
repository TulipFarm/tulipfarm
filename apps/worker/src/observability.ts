import { createHash, randomUUID } from "node:crypto";
import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { ROUTINE_SERVICE_PRINCIPAL_ID } from "@tulipfarm/constants";
import type { AiMetricsSink, AiTracesSink } from "@tulipfarm/observability";
import type {
  LlmCallRecord,
  SpendSink,
  ToolCallRecord,
  TurnRecord,
} from "@tulipfarm/turn-executor";
import type { Queryable } from "./db";
import type { RoutineAgentPort, RoutineAgentRequest } from "./routine/agent-port";
import type { RoutineToolPort, RoutineToolRequest } from "./routine/tool-port";

export type {
  LlmCallRecord,
  SpendSink,
  ToolCallRecord,
  TurnRecord,
} from "@tulipfarm/turn-executor";

export interface WorkerTelemetrySinks {
  metrics?: AiMetricsSink;
  traces?: AiTracesSink;
}

/** Drops undefined keys so stored attributes never contain misleading null-like values. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function traceId(value: string): string {
  return digest(`trace:${value}`).slice(0, 32);
}

interface ObsInsert {
  id: string;
  type: "llm_call" | "tool_call" | "turn";
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
  toolName?: string;
  subjectKind?: string;
  subjectId?: string;
  attributes: Record<string, unknown>;
  runId?: string;
}

/**
 * Writes actual Worker model, Tool, and Turn outcomes directly to the durable observability ledger.
 *
 * Stable event ids make retries harmless. Metrics and traces run only after the insert succeeds,
 * and only for a newly inserted row, so a replay cannot inflate either durable or exported counts.
 */
export class PgSpendSink implements SpendSink {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Queryable,
    private readonly log?: { warn(obj: unknown, msg?: string): void },
    private readonly telemetry: WorkerTelemetrySinks = {}
  ) {}

  recordLlmCall(record: LlmCallRecord): void {
    const usage = record.usage;
    const scope = record.runId ?? record.conversationId;
    const trace = scope === undefined ? undefined : traceId(scope);
    this.enqueue(scope ?? record.requestId ?? randomUUID(), async () => {
      const inserted = await this.insert({
        id:
          record.requestId === undefined
            ? randomUUID()
            : stableUuid(
                `llm_call:${record.runId ?? record.conversationId ?? ""}:${record.requestId}`
              ),
        type: "llm_call",
        agentId: record.agentId,
        conversationId: record.conversationId,
        model: record.model,
        provider: record.provider,
        tier: record.tier,
        tokensIn: usage?.inputTokens,
        tokensOut: usage?.outputTokens,
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
          requestId: record.requestId,
          traceId: trace,
        }),
        runId: record.runId,
      });
      if (!inserted) return;
      this.telemetry.metrics?.recordLlmCall({
        model: record.model ?? "unknown",
        provider: record.provider ?? null,
        ...(record.tier === undefined ? {} : { tier: record.tier }),
        status: record.status,
        tokensIn: usage?.inputTokens ?? 0,
        tokensOut: usage?.outputTokens ?? 0,
        costUsd: usage?.costBasis === "priced" ? (usage.costUsd ?? null) : null,
      });
      if (scope !== undefined && trace !== undefined) {
        this.telemetry.traces?.spanStep(scope, {
          traceId: trace,
          name: record.model ?? "model",
          kind: "llm_call",
          ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
          status: record.status,
          attributes: { "tulipfarm.provider": record.provider ?? "unknown" },
        });
      }
    });
  }

  recordToolCall(record: ToolCallRecord): void {
    const trace = traceId(record.runId);
    this.enqueue(record.runId, async () => {
      const inserted = await this.insert({
        id: stableUuid(`tool_call:${record.runId}:${record.callId}`),
        type: "tool_call",
        agentId: record.agentId,
        durationMs: record.durationMs,
        status: record.status,
        toolName: record.toolName,
        attributes: compact({
          runId: record.runId,
          stateId: record.stateId,
          callId: record.callId,
          errorCode: record.errorCode,
          traceId: trace,
        }),
        runId: record.runId,
      });
      if (!inserted) return;
      this.telemetry.metrics?.recordToolCall({
        toolName: record.toolName,
        status: record.status,
      });
      this.telemetry.traces?.spanStep(record.runId, {
        traceId: trace,
        name: record.toolName,
        kind: "tool_call",
        ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
        status: record.status,
        attributes:
          record.errorCode === undefined ? {} : { "tulipfarm.error_code": record.errorCode },
      });
    });
  }

  recordTurn(record: TurnRecord): void {
    const scope = record.runId ?? record.conversationId;
    const trace = scope === undefined ? undefined : traceId(scope);
    this.enqueue(scope ?? record.turnId ?? randomUUID(), async () => {
      const totals = await this.turnTotals(record.runId, record.turnId);
      const inserted = await this.insert({
        id:
          record.runId === undefined && record.turnId === undefined
            ? randomUUID()
            : stableUuid(`turn:${record.runId ?? ""}:${record.turnId ?? ""}`),
        type: "turn",
        agentId: record.agentId,
        conversationId: record.conversationId,
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        durationMs: record.durationMs,
        status: record.status,
        subjectKind: record.principal?.kind,
        subjectId: record.principal?.id,
        attributes: compact({
          runId: record.runId,
          turnId: record.turnId,
          steps: totals.steps,
          traceId: trace,
        }),
        runId: record.runId,
      });
      if (!inserted) return;
      this.telemetry.metrics?.recordTurn({ status: record.status });
      if (scope !== undefined && trace !== undefined) {
        this.telemetry.traces?.finishTurn(scope, {
          traceId: trace,
          agentId: record.agentId ?? null,
          status: record.status,
          ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
          steps: totals.steps,
          tokensIn: totals.tokensIn,
          tokensOut: totals.tokensOut,
        });
      }
    });
  }

  private enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error: unknown) => {
        this.log?.warn(
          {
            event: "observability.write_failed",
            errorType: error instanceof Error ? error.name : "unknown",
          },
          "failed to record observability event"
        );
      })
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
  }

  /** Waits for every durable write already accepted by this sink. */
  async flush(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all(this.queues.values());
    }
  }

  private async turnTotals(
    runId: string | undefined,
    turnId: string | undefined
  ): Promise<{ tokensIn: number; tokensOut: number; steps: number }> {
    if (runId === undefined) return { tokensIn: 0, tokensOut: 0, steps: 0 };
    const result = await this.db.query(
      `SELECT COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COUNT(*) AS steps
         FROM obs_event
        WHERE type = 'llm_call'
          AND attributes->>'runId' = $1
          AND ($2::text IS NULL OR attributes->>'turnId' = $2)`,
      [runId, turnId ?? null]
    );
    const row = result.rows[0];
    return {
      tokensIn: Number(row?.tokens_in ?? 0),
      tokensOut: Number(row?.tokens_out ?? 0),
      steps: Number(row?.steps ?? 0),
    };
  }

  private async insert(row: ObsInsert): Promise<boolean> {
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO obs_event
         (id, ts, type, agent_id, conversation_id, model, provider, tier,
          tokens_in, tokens_out, cost_usd, duration_ms, status, tool_name, subject_kind,
          subject_id, attributes, created_at)
       VALUES (
         $1, $2, $3, $4,
         COALESCE($5, (SELECT conversation_id FROM conversation_turns WHERE run_id = $19 LIMIT 1)),
         $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        row.id,
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
        row.toolName ?? null,
        row.subjectKind ?? null,
        row.subjectId ?? null,
        JSON.stringify(row.attributes),
        now,
        row.runId ?? null,
      ]
    );
    return result.rows.length > 0;
  }
}

/** Wraps the real dispatch port. Only terminal metadata crosses into telemetry. */
export function observeToolDispatch(
  inner: ToolDispatchPort,
  sink: SpendSink,
  now: () => number = Date.now
): ToolDispatchPort {
  return {
    async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
      const startedAt = now();
      const record = (status: "ok" | "error", errorCode?: string): void => {
        sink.recordToolCall?.({
          runId: request.runId,
          stateId: request.stateId,
          callId: request.callId,
          toolName: request.name,
          ...(request.agentName === undefined ? {} : { agentId: request.agentName }),
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          status,
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      };
      let result: ToolDispatchResult;
      try {
        result = await inner.dispatch(request);
      } catch (error) {
        record("error", "dispatch_threw");
        throw error;
      }
      if (result.status === "awaiting_approval" || result.status === "awaiting_child")
        return result;
      if (result.status === "succeeded") record("ok");
      else record("error", result.status);
      return result;
    },
  };
}

/** Records terminal Routine Tool executions without retaining arguments, output, or provider text. */
export function observeRoutineToolPort(
  inner: RoutineToolPort,
  sink: SpendSink,
  now: () => number = Date.now
): RoutineToolPort {
  return {
    async execute(request: RoutineToolRequest) {
      const startedAt = now();
      const record = (status: "ok" | "error", errorCode?: string): void => {
        sink.recordToolCall?.({
          runId: request.runId,
          stateId: request.stateKey,
          callId: request.plan.effectId,
          toolName: request.plan.toolRef.name,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          status,
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      };
      try {
        const result = await inner.execute(request);
        if (result.kind === "succeeded") record("ok");
        else if (result.kind === "failed") record("error", result.reason);
        return result;
      } catch (error) {
        record("error", "dispatch_threw");
        throw error;
      }
    },
  };
}

/** Treats each terminal Routine Agent attempt as a Turn-equivalent reliability event. */
export function observeRoutineAgentPort(
  inner: RoutineAgentPort,
  sink: SpendSink,
  now: () => number = Date.now
): RoutineAgentPort {
  return {
    async execute(request: RoutineAgentRequest) {
      const startedAt = now();
      const record = (status: "ok" | "error"): void => {
        sink.recordTurn({
          runId: request.runId,
          turnId: `${request.stateKey}:${request.attempt}`,
          agentId: request.plan.agentRef.name,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          status,
          principal: { kind: "service", id: ROUTINE_SERVICE_PRINCIPAL_ID },
        });
      };
      try {
        const result = await inner.execute(request);
        if (result.kind === "succeeded") record("ok");
        else if (result.kind === "failed") record("error");
        return result;
      } catch (error) {
        record("error");
        throw error;
      }
    },
  };
}
