import type { OtlpTarget } from "./metrics";

/**
 * Dependency-free OTLP/HTTP-JSON trace export to Grafana Cloud (Tempo). One trace per chat turn: a
 * root `turn` span with child `llm_call` / `tool_call` spans, accumulated per conversation between
 * turn boundaries (single-tenant V1 runs turns sequentially per conversation). Spans are timed from
 * event arrival minus the step's durationMs. Only started when observability is enabled.
 */

export interface TracesSink {
  spanStep(conversationId: string, d: SpanInput): void;
  finishTurn(conversationId: string, d: TurnSpanInput): void;
}

export interface SpanInput {
  name: string;
  kind: "llm_call" | "tool_call";
  durationMs?: number;
  status: string;
  attributes: Record<string, string | number>;
}

export interface TurnSpanInput {
  agentId: string | null;
  status: string;
  durationMs?: number;
  steps: number;
  tokensIn: number;
  tokensOut: number;
}

interface PendingSpan {
  name: string;
  startNano: bigint;
  endNano: bigint;
  status: string;
  attributes: Record<string, string | number>;
}

// Backstops against unbounded growth if a turn never emits TURN_FINISHED (abort/crash): cap spans
// per conversation and the number of in-flight conversations (oldest evicted first).
const MAX_SPANS_PER_TURN = 1000;
const MAX_PENDING_TURNS = 2000;

/** Finite-safe milliseconds → never lets NaN/Infinity reach BigInt() (which would throw). */
function safeMs(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;
}

/** OTLP span status: only genuine failures map to ERROR(2). `ok`/`fallback` are not errors. */
function statusCode(status: string): number {
  return status === "error" || status === "timeout" || status === "blocked" ? 2 : 0;
}

function hex(bytes: number, rand: () => number): string {
  let s = "";
  for (let i = 0; i < bytes; i++) {
    s += Math.floor(rand() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return s;
}

function attrList(attributes: Record<string, string | number>): unknown[] {
  return Object.entries(attributes).map(([key, v]) => ({
    key,
    value: typeof v === "number" ? { doubleValue: v } : { stringValue: v },
  }));
}

export class OtlpTracesExporter implements TracesSink {
  private pending = new Map<string, PendingSpan[]>();
  private resourceSpans: unknown[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly authHeader: string;

  constructor(
    private readonly target: OtlpTarget,
    private readonly nowMs: () => number = Date.now,
    private readonly rand: () => number = Math.random,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (msg: string) => void = (m) => console.warn(m)
  ) {
    this.authHeader = `Basic ${Buffer.from(`${target.instanceId}:${target.token}`).toString("base64")}`;
  }

  spanStep(conversationId: string, d: SpanInput): void {
    const endNano = BigInt(safeMs(this.nowMs())) * 1_000_000n;
    const startNano = endNano - BigInt(safeMs(d.durationMs)) * 1_000_000n;
    const list = this.pending.get(conversationId);
    if (list) {
      if (list.length >= MAX_SPANS_PER_TURN) return; // drop excess; the turn span still flushes
    } else if (this.pending.size >= MAX_PENDING_TURNS) {
      // Evict the oldest in-flight conversation (insertion order) to bound memory.
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const next = list ?? [];
    next.push({
      name: d.name,
      startNano,
      endNano,
      status: d.status,
      attributes: { "tulipfarm.kind": d.kind, ...d.attributes },
    });
    this.pending.set(conversationId, next);
  }

  finishTurn(conversationId: string, d: TurnSpanInput): void {
    const children = this.pending.get(conversationId) ?? [];
    this.pending.delete(conversationId);
    const endNano = BigInt(safeMs(this.nowMs())) * 1_000_000n;
    const startNano = endNano - BigInt(safeMs(d.durationMs)) * 1_000_000n;

    const traceId = hex(16, this.rand);
    const rootSpanId = hex(8, this.rand);
    const toSpan = (
      spanId: string,
      parentId: string | undefined,
      name: string,
      start: bigint,
      end: bigint,
      status: string,
      attributes: Record<string, string | number>
    ) => ({
      traceId,
      spanId,
      parentSpanId: parentId,
      name,
      kind: 1,
      startTimeUnixNano: `${start}`,
      endTimeUnixNano: `${end}`,
      attributes: attrList(attributes),
      status: { code: statusCode(status) },
    });

    const spans: unknown[] = [
      toSpan(rootSpanId, undefined, "turn", startNano, endNano, d.status, {
        "tulipfarm.kind": "turn",
        "tulipfarm.agent": d.agentId ?? "unknown",
        "tulipfarm.steps": d.steps,
        "tulipfarm.tokens_in": d.tokensIn,
        "tulipfarm.tokens_out": d.tokensOut,
      }),
      ...children.map((c) =>
        toSpan(
          hex(8, this.rand),
          rootSpanId,
          c.name,
          c.startNano,
          c.endNano,
          c.status,
          c.attributes
        )
      ),
    ];

    this.resourceSpans.push({
      resource: { attributes: [{ key: "service.name", value: { stringValue: "tulipfarm" } }] },
      scopeSpans: [{ scope: { name: "tulipfarm.observability" }, spans }],
    });
  }

  async flush(): Promise<void> {
    if (this.resourceSpans.length === 0) return;
    const batch = this.resourceSpans;
    this.resourceSpans = [];
    try {
      const res = await this.fetchImpl(`${this.target.endpoint.replace(/\/$/, "")}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.authHeader },
        body: JSON.stringify({ resourceSpans: batch }),
      });
      if (!res.ok) this.log(`[observability] OTLP traces push failed: ${res.status}`);
    } catch (err) {
      this.log(
        `[observability] OTLP traces error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Build the OTLP/JSON ExportTraceServiceRequest currently buffered (for tests). */
  buildPayload(): { resourceSpans: unknown[] } {
    return { resourceSpans: this.resourceSpans };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
