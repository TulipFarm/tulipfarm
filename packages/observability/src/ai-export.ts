/** Dependency-free OTLP export for AI execution telemetry emitted by the Worker. */

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
}

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<FetchResponse>;

interface TimerHandle {
  unref?(): void;
}

const runtime = globalThis as unknown as {
  fetch: FetchLike;
  setInterval(callback: () => void, milliseconds: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
};

declare const Buffer: {
  from(value: string): { toString(encoding: "base64"): string };
};

export interface OtlpTarget {
  endpoint: string;
  instanceId: string;
  token: string;
}

export interface AiMetricsSink {
  recordLlmCall(input: {
    model: string;
    provider: string | null;
    tier?: string;
    status: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
  }): void;
  recordToolCall(input: { toolName: string; status: string }): void;
  recordTurn(input: { status: string }): void;
}

export interface AiTracesSink {
  spanStep(
    traceKey: string,
    input: {
      traceId: string;
      name: string;
      kind: "llm_call" | "tool_call";
      durationMs?: number;
      status: string;
      attributes: Record<string, string | number>;
    }
  ): void;
  finishTurn(
    traceKey: string,
    input: {
      traceId: string;
      agentId: string | null;
      status: string;
      durationMs?: number;
      steps: number;
      tokensIn: number;
      tokensOut: number;
    }
  ): void;
}

type Labels = Record<string, string>;

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function attributes(values: Record<string, string | number>): unknown[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === "number" ? { doubleValue: value } : { stringValue: value },
  }));
}

function unixNano(milliseconds: number): string {
  const safe = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds)) : 0;
  return `${BigInt(safe) * 1_000_000n}`;
}

function safeDuration(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
}

function statusCode(status: string): number {
  return status === "error" || status === "timeout" || status === "blocked" ? 2 : 0;
}

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  add(labels: Labels, value = 1): void {
    if (!Number.isFinite(value)) return;
    const key = labelsKey(labels);
    const current = this.values.get(key);
    if (current === undefined) {
      this.values.set(key, { labels, value });
      return;
    }
    current.value += value;
  }

  points(): readonly { labels: Labels; value: number }[] {
    return [...this.values.values()];
  }
}

export class OtlpAiMetricsExporter implements AiMetricsSink {
  private readonly calls = new Counter();
  private readonly tokens = new Counter();
  private readonly cost = new Counter();
  private readonly tools = new Counter();
  private readonly turns = new Counter();
  private timer: TimerHandle | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private readonly startedAt: string;
  private readonly authorization: string;

  constructor(
    private readonly target: OtlpTarget,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: FetchLike = runtime.fetch,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.startedAt = unixNano(now());
    this.authorization = `Basic ${Buffer.from(`${target.instanceId}:${target.token}`).toString("base64")}`;
  }

  recordLlmCall(input: {
    model: string;
    provider: string | null;
    tier?: string;
    status: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
  }): void {
    const labels: Labels = {
      model: input.model,
      provider: input.provider ?? "unknown",
      status: input.status,
    };
    if (input.tier !== undefined) labels.tier = input.tier;
    this.calls.add(labels);
    this.tokens.add({ model: input.model }, input.tokensIn + input.tokensOut);
    if (input.costUsd !== null) this.cost.add({ model: input.model }, input.costUsd);
  }

  recordToolCall(input: { toolName: string; status: string }): void {
    this.tools.add({ tool_name: input.toolName, status: input.status });
  }

  recordTurn(input: { status: string }): void {
    this.turns.add({ status: input.status });
  }

  buildPayload(): Record<string, unknown> {
    const time = unixNano(this.now());
    const metric = (name: string, counter: Counter) => ({
      name,
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: counter.points().map((point) => ({
          attributes: attributes(point.labels),
          startTimeUnixNano: this.startedAt,
          timeUnixNano: time,
          asDouble: point.value,
        })),
      },
    });
    const metrics = [
      metric("llm_calls_total", this.calls),
      metric("llm_tokens_total", this.tokens),
      metric("llm_cost_usd_total", this.cost),
      metric("tool_calls_total", this.tools),
      metric("turns_total", this.turns),
    ].filter((entry) => entry.sum.dataPoints.length > 0);
    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "tulipfarm-worker" } }],
          },
          scopeMetrics: [{ scope: { name: "tulipfarm.observability" }, metrics }],
        },
      ],
    };
  }

  async flush(): Promise<void> {
    const next = this.flushQueue.then(() => this.flushOnce());
    this.flushQueue = next;
    await next;
  }

  private async flushOnce(): Promise<void> {
    const payload = this.buildPayload();
    const metrics = (
      (payload.resourceMetrics as Array<{ scopeMetrics: Array<{ metrics: unknown[] }> }>)[0]
        ?.scopeMetrics[0]?.metrics ?? []
    ).length;
    if (metrics === 0) return;
    try {
      const response = await this.fetchImpl(
        `${this.target.endpoint.replace(/\/$/, "")}/v1/metrics`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: this.authorization },
          body: JSON.stringify(payload),
        }
      );
      if (!response.ok) this.log(`[observability] OTLP metrics push failed: ${response.status}`);
    } catch {
      this.log("[observability] OTLP metrics request failed");
    }
  }

  start(intervalMs = 15_000): void {
    if (this.timer !== null) return;
    this.timer = runtime.setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) runtime.clearInterval(this.timer);
    this.timer = null;
  }
}

interface PendingSpan {
  name: string;
  startNano: bigint;
  endNano: bigint;
  status: string;
  attributes: Record<string, string | number>;
}

export class OtlpAiTracesExporter implements AiTracesSink {
  private readonly pending = new Map<string, PendingSpan[]>();
  private resourceSpans: unknown[] = [];
  private timer: TimerHandle | null = null;
  private flushQueue: Promise<void> = Promise.resolve();
  private readonly authorization: string;

  constructor(
    private readonly target: OtlpTarget,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly fetchImpl: FetchLike = runtime.fetch,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.authorization = `Basic ${Buffer.from(`${target.instanceId}:${target.token}`).toString("base64")}`;
  }

  spanStep(
    traceKey: string,
    input: {
      traceId: string;
      name: string;
      kind: "llm_call" | "tool_call";
      durationMs?: number;
      status: string;
      attributes: Record<string, string | number>;
    }
  ): void {
    const endNano = BigInt(Math.floor(this.now())) * 1_000_000n;
    const startNano = endNano - BigInt(safeDuration(input.durationMs)) * 1_000_000n;
    const spans = this.pending.get(traceKey) ?? [];
    if (spans.length >= 1000) return;
    spans.push({
      name: input.name,
      startNano,
      endNano,
      status: input.status,
      attributes: { "tulipfarm.kind": input.kind, ...input.attributes },
    });
    this.pending.set(traceKey, spans);
  }

  finishTurn(
    traceKey: string,
    input: {
      traceId: string;
      agentId: string | null;
      status: string;
      durationMs?: number;
      steps: number;
      tokensIn: number;
      tokensOut: number;
    }
  ): void {
    const children = this.pending.get(traceKey) ?? [];
    this.pending.delete(traceKey);
    const endNano = BigInt(Math.floor(this.now())) * 1_000_000n;
    const startNano = endNano - BigInt(safeDuration(input.durationMs)) * 1_000_000n;
    const rootSpanId = this.spanId();
    const span = (
      spanId: string,
      parentSpanId: string | undefined,
      name: string,
      start: bigint,
      end: bigint,
      status: string,
      values: Record<string, string | number>
    ) => ({
      traceId: input.traceId,
      spanId,
      parentSpanId,
      name,
      kind: 1,
      startTimeUnixNano: `${start}`,
      endTimeUnixNano: `${end}`,
      attributes: attributes(values),
      status: { code: statusCode(status) },
    });
    this.resourceSpans.push({
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "tulipfarm-worker" } }],
      },
      scopeSpans: [
        {
          scope: { name: "tulipfarm.observability" },
          spans: [
            span(rootSpanId, undefined, "turn", startNano, endNano, input.status, {
              "tulipfarm.kind": "turn",
              "tulipfarm.agent": input.agentId ?? "unknown",
              "tulipfarm.steps": input.steps,
              "tulipfarm.tokens_in": input.tokensIn,
              "tulipfarm.tokens_out": input.tokensOut,
            }),
            ...children.map((child) =>
              span(
                this.spanId(),
                rootSpanId,
                child.name,
                child.startNano,
                child.endNano,
                child.status,
                child.attributes
              )
            ),
          ],
        },
      ],
    });
  }

  buildPayload(): { resourceSpans: unknown[] } {
    return { resourceSpans: this.resourceSpans };
  }

  async flush(): Promise<void> {
    const next = this.flushQueue.then(() => this.flushOnce());
    this.flushQueue = next;
    await next;
  }

  private async flushOnce(): Promise<void> {
    if (this.resourceSpans.length === 0) return;
    const batch = this.resourceSpans;
    this.resourceSpans = [];
    try {
      const response = await this.fetchImpl(
        `${this.target.endpoint.replace(/\/$/, "")}/v1/traces`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: this.authorization },
          body: JSON.stringify({ resourceSpans: batch }),
        }
      );
      if (!response.ok) {
        this.resourceSpans.unshift(...batch);
        this.log(`[observability] OTLP traces push failed: ${response.status}`);
      }
    } catch {
      this.resourceSpans.unshift(...batch);
      this.log("[observability] OTLP traces request failed");
    }
  }

  start(intervalMs = 15_000): void {
    if (this.timer !== null) return;
    this.timer = runtime.setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) runtime.clearInterval(this.timer);
    this.timer = null;
  }

  private spanId(): string {
    let value = "";
    for (let index = 0; index < 8; index += 1) {
      value += Math.floor(this.random() * 256)
        .toString(16)
        .padStart(2, "0");
    }
    return value;
  }
}
