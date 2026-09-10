/** Dependency-free OTLP metrics export with bounded labels and cumulative monotonic sums. */

export interface LlmCallMetric {
  model: string;
  provider: string | null;
  tier?: string;
  status: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** Sink fed by the observability subscriber; OTLP implements it when enabled. */
export interface MetricsSink {
  recordLlmCall(d: LlmCallMetric): void;
  recordToolCall(d: { toolName: string; status: string }): void;
  recordTurn(d: { status: string }): void;
  recordJob(d: { queue: string; status: string }): void;
  recordSoulPublication?(d: { status: string; stage: string; latencyMs?: number }): void;
  recordSurface?(d: {
    target: string;
    component: string;
    version: string;
    validation: string;
    render: string;
    interaction?: string;
    delivery?: string;
    validationPaths: readonly string[];
  }): void;
}

type LabelSet = Record<string, string>;
interface Point {
  labels: LabelSet;
  value: number;
}

const SERVICE_NAME = "tulipfarm";
const SCOPE = "tulipfarm.observability";

function labelKey(labels: LabelSet): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

// Labels are bounded by design, but a provider that returns ever-varying model ids (e.g. dated
// variants) could still grow counters. Cap label sets per metric as a hard backstop.
const MAX_LABEL_SETS = 2000;

/** Finite-safe epoch-ms → nanosecond string (BigInt(NaN/Infinity) would throw). */
function unixNano(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.floor(ms) : 0;
  return `${BigInt(safe) * 1_000_000n}`;
}

/** Cumulative monotonic counter, sharded by label set. */
class Counter {
  private points = new Map<string, Point>();
  add(labels: LabelSet, value = 1): void {
    if (!Number.isFinite(value)) return;
    const key = labelKey(labels);
    const existing = this.points.get(key);
    if (existing) existing.value += value;
    else if (this.points.size < MAX_LABEL_SETS) this.points.set(key, { labels, value });
  }

  snapshot(): Point[] {
    return [...this.points.values()];
  }
}

class Histogram {
  private points = new Map<string, Point>();
  private counts = new Map<string, number>();

  record(labels: LabelSet, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = labelKey(labels);
    const existing = this.points.get(key);
    if (existing) {
      existing.value += value;
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    } else if (this.points.size < MAX_LABEL_SETS) {
      this.points.set(key, { labels, value });
      this.counts.set(key, 1);
    }
  }

  snapshot(): Array<Point & { count: number }> {
    return [...this.points.entries()].map(([key, point]) => ({
      ...point,
      count: this.counts.get(key) ?? 0,
    }));
  }
}

export interface OtlpTarget {
  /** Grafana Cloud OTLP base, e.g. https://otlp-gateway-<region>.grafana.net/otlp */
  endpoint: string;
  instanceId: string;
  /** Resolved token (already de-referenced from env:///secret). */
  token: string;
}

export class OtlpMetricsExporter implements MetricsSink {
  private readonly counters: Record<string, Counter> = {
    llm_calls_total: new Counter(),
    llm_tokens_total: new Counter(),
    llm_cost_usd_total: new Counter(),
    tool_calls_total: new Counter(),
    turns_total: new Counter(),
    job_runs_total: new Counter(),
    soul_publication_outcomes_total: new Counter(),
    surface_render_total: new Counter(),
    surface_validation_total: new Counter(),
    surface_interaction_total: new Counter(),
    surface_delivery_total: new Counter(),
  };
  private readonly histograms: Record<string, Histogram> = {
    soul_publication_latency_ms: new Histogram(),
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startUnixNano: string;
  private readonly authHeader: string;

  constructor(
    private readonly target: OtlpTarget,
    private readonly nowMs: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (msg: string) => void = (m) => console.warn(m)
  ) {
    this.startUnixNano = unixNano(this.nowMs());
    this.authHeader = `Basic ${Buffer.from(`${target.instanceId}:${target.token}`).toString("base64")}`;
  }

  recordLlmCall(d: LlmCallMetric): void {
    const labels: LabelSet = {
      model: d.model,
      provider: d.provider ?? "unknown",
      status: d.status,
    };
    if (d.tier) labels.tier = d.tier;
    this.counters.llm_calls_total.add(labels);
    this.counters.llm_tokens_total.add({ model: d.model }, d.tokensIn + d.tokensOut);
    if (d.costUsd != null) this.counters.llm_cost_usd_total.add({ model: d.model }, d.costUsd);
  }

  recordToolCall(d: { toolName: string; status: string }): void {
    this.counters.tool_calls_total.add({ tool_name: d.toolName, status: d.status });
  }

  recordTurn(d: { status: string }): void {
    this.counters.turns_total.add({ status: d.status });
  }

  recordJob(d: { queue: string; status: string }): void {
    this.counters.job_runs_total.add({ queue: d.queue, status: d.status });
  }

  recordSoulPublication(d: { status: string; stage: string; latencyMs?: number }): void {
    const labels = { status: d.status, stage: d.stage };
    this.counters.soul_publication_outcomes_total.add(labels);
    if (d.latencyMs !== undefined) {
      this.histograms.soul_publication_latency_ms.record(labels, d.latencyMs);
    }
  }

  recordSurface(d: {
    target: string;
    component: string;
    version: string;
    validation: string;
    render: string;
    interaction?: string;
    delivery?: string;
    validationPaths: readonly string[];
  }): void {
    const labels = {
      target: d.target,
      component: d.component,
      version: d.version,
    };
    this.counters.surface_render_total.add({ ...labels, result: d.render });
    this.counters.surface_validation_total.add({ ...labels, result: d.validation });
    for (const path of d.validationPaths) {
      this.counters.surface_validation_total.add({ ...labels, result: "invalid", path });
    }
    if (d.interaction) {
      this.counters.surface_interaction_total.add({ ...labels, result: d.interaction });
    }
    if (d.delivery) {
      this.counters.surface_delivery_total.add({ ...labels, status: d.delivery });
    }
  }

  /** Build the OTLP/JSON ExportMetricsServiceRequest for the current cumulative totals. */
  buildPayload(): Record<string, unknown> {
    const timeUnixNano = unixNano(this.nowMs());
    const sums = Object.entries(this.counters)
      .map(([name, counter]) => ({
        name,
        sum: {
          aggregationTemporality: 2, // CUMULATIVE
          isMonotonic: true,
          dataPoints: counter.snapshot().map((p) => ({
            attributes: Object.entries(p.labels).map(([key, v]) => ({
              key,
              value: { stringValue: v },
            })),
            startTimeUnixNano: this.startUnixNano,
            timeUnixNano,
            asDouble: p.value,
          })),
        },
      }))
      .filter((m) => (m.sum.dataPoints as unknown[]).length > 0);
    const histograms = Object.entries(this.histograms)
      .map(([name, histogram]) => ({
        name,
        histogram: {
          aggregationTemporality: 2, // CUMULATIVE
          dataPoints: histogram.snapshot().map((p) => ({
            attributes: Object.entries(p.labels).map(([key, v]) => ({
              key,
              value: { stringValue: v },
            })),
            startTimeUnixNano: this.startUnixNano,
            timeUnixNano,
            count: p.count,
            sum: p.value,
          })),
        },
      }))
      .filter((m) => (m.histogram.dataPoints as unknown[]).length > 0);
    const metrics = [...sums, ...histograms];

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
          },
          scopeMetrics: [{ scope: { name: SCOPE }, metrics }],
        },
      ],
    };
  }

  async flush(): Promise<void> {
    const payload = this.buildPayload();
    if (
      (payload.resourceMetrics as [{ scopeMetrics: [{ metrics: unknown[] }] }])[0].scopeMetrics[0]
        .metrics.length === 0
    ) {
      return; // nothing accumulated yet
    }
    try {
      const res = await this.fetchImpl(`${this.target.endpoint.replace(/\/$/, "")}/v1/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.authHeader },
        body: JSON.stringify(payload),
      });
      if (!res.ok) this.log(`[observability] OTLP push failed: ${res.status} ${res.statusText}`);
    } catch (err) {
      this.log(
        `[observability] OTLP push error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
