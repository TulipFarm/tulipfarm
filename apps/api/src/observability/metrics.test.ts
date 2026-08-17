import { describe, expect, it, vi } from "vitest";
import { OtlpMetricsExporter } from "./metrics";

const TARGET = { endpoint: "https://otlp.grafana.net/otlp", instanceId: "123", token: "tok" };

function exporter(fetchImpl?: typeof fetch) {
  return new OtlpMetricsExporter(TARGET, () => 1_700_000_000_000, fetchImpl ?? (vi.fn() as never));
}

type OtlpMetric = {
  name: string;
  sum?: { dataPoints: Array<{ asDouble: number }> };
  histogram?: { dataPoints: Array<{ count: number; sum: number }> };
};

function metricsByName(e: { buildPayload(): unknown }): Record<string, OtlpMetric> {
  const payload = e.buildPayload() as {
    resourceMetrics: [{ scopeMetrics: [{ metrics: OtlpMetric[] }] }];
  };
  return Object.fromEntries(
    payload.resourceMetrics[0].scopeMetrics[0].metrics.map((metric) => [metric.name, metric])
  );
}

function sumOf(metric: OtlpMetric): number {
  return (metric.sum?.dataPoints ?? []).reduce((total, point) => total + point.asDouble, 0);
}

describe("OtlpMetricsExporter", () => {
  it("accumulates cumulative counters with bounded labels", () => {
    const e = exporter();
    e.recordLlmCall({
      model: "claude-opus-4-8",
      provider: "anthropic",
      tier: "complex",
      status: "ok",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.02,
    });
    e.recordLlmCall({
      model: "claude-opus-4-8",
      provider: "anthropic",
      tier: "complex",
      status: "ok",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
    });

    const payload = e.buildPayload() as {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: Array<{
                name: string;
                sum: { dataPoints: Array<{ asDouble: number; attributes: { key: string }[] }> };
              }>;
            },
          ];
        },
      ];
    };
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const byName = Object.fromEntries(metrics.map((m) => [m.name, m]));

    // Two identical-label calls fold into one cumulative point of value 2.
    expect(byName.llm_calls_total.sum.dataPoints).toHaveLength(1);
    expect(byName.llm_calls_total.sum.dataPoints[0].asDouble).toBe(2);
    // tokens cumulative = 165, cost cumulative = 0.03
    expect(byName.llm_tokens_total.sum.dataPoints[0].asDouble).toBe(165);
    expect(byName.llm_cost_usd_total.sum.dataPoints[0].asDouble).toBeCloseTo(0.03, 6);
    // No high-cardinality labels leaked (only model/provider/status/tier on calls).
    const keys = byName.llm_calls_total.sum.dataPoints[0].attributes.map((a) => a.key).sort();
    expect(keys).toEqual(["model", "provider", "status", "tier"]);
  });

  it("omits unpriced cost from the cost counter", () => {
    const e = exporter();
    e.recordLlmCall({
      model: "x",
      provider: null,
      status: "ok",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: null,
    });
    const payload = e.buildPayload() as {
      resourceMetrics: [{ scopeMetrics: [{ metrics: Array<{ name: string }> }] }];
    };
    const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
    expect(names).toContain("llm_calls_total");
    expect(names).not.toContain("llm_cost_usd_total"); // no cost point ⇒ metric pruned
  });

  it("records Surface validation, rendering, interaction, and delivery", () => {
    const e = exporter();
    e.recordSurface({
      target: "slack/message",
      component: "RecordTable",
      version: "1.0",
      validation: "invalid",
      render: "failed",
      interaction: "rejected",
      delivery: "failed",
      validationPaths: ["/props/records"],
    });
    const payload = e.buildPayload() as {
      resourceMetrics: [{ scopeMetrics: [{ metrics: Array<{ name: string }> }] }];
    };
    const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map((metric) => metric.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "surface_render_total",
        "surface_validation_total",
        "surface_interaction_total",
        "surface_delivery_total",
      ])
    );
  });

  it("records every Soul publication outcome and latency when available", () => {
    const e = exporter();
    e.recordSoulPublication({ status: "advanced", stage: "active", latencyMs: 42 });
    e.recordSoulPublication({ status: "failed", stage: "projected" });
    e.recordSoulPublication({ status: "dead_lettered", stage: "stored" });

    const payload = e.buildPayload() as {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: Array<{
                name: string;
                sum?: { dataPoints: Array<{ asDouble: number }> };
                histogram?: { dataPoints: Array<{ count: number; sum: number }> };
              }>;
            },
          ];
        },
      ];
    };
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const byName = Object.fromEntries(metrics.map((metric) => [metric.name, metric]));

    expect(byName.soul_publication_outcomes_total.sum?.dataPoints).toHaveLength(3);
    expect(
      byName.soul_publication_outcomes_total.sum?.dataPoints.reduce(
        (total, point) => total + point.asDouble,
        0
      )
    ).toBe(3);
    expect(byName.soul_publication_latency_ms.histogram?.dataPoints).toEqual([
      expect.objectContaining({ count: 1, sum: 42 }),
    ]);
  });

  it("records Curator stages, effect states, rejection reasons, and staleness", () => {
    const e = exporter();
    e.recordCurator({ stage: "mint", scope: "user", outcome: "minted" });
    e.recordCurator({
      stage: "mint",
      scope: "user",
      outcome: "skipped",
      reason: "budget_exhausted",
    });
    e.recordCurator({
      stage: "settle",
      scope: "user",
      outcome: "settled",
      recorded: 3,
      rejected: 2,
    });
    e.recordCurator({ stage: "recovery", outcome: "recovered", count: 4 });
    e.recordCurator({ stage: "recovery", outcome: "swept", backlogAgeSeconds: 600 });
    e.recordCurator({ stage: "document", scope: "user", outcome: "written", documentBytes: 8_192 });

    const byName = metricsByName(e);

    expect(sumOf(byName.curator_stages_total)).toBe(1 + 1 + 1 + 4 + 1 + 1);
    expect(sumOf(byName.curator_effects_total)).toBe(5);
    expect(byName.curator_effects_total.sum?.dataPoints).toHaveLength(2);
    expect(byName.curator_rejections_total.sum?.dataPoints).toEqual([
      expect.objectContaining({ asDouble: 1 }),
    ]);
    expect(byName.curator_backlog_age_seconds.histogram?.dataPoints).toEqual([
      expect.objectContaining({ count: 1, sum: 600 }),
    ]);
    expect(byName.curator_document_bytes.histogram?.dataPoints).toEqual([
      expect.objectContaining({ count: 1, sum: 8_192 }),
    ]);
  });

  // A denial for a job that was never found has no scope. Dropping the label entirely would make
  // its series shape differ from every other Curator series and break dashboard grouping.
  it("labels a scopeless Curator report as unknown rather than omitting the label", () => {
    const e = exporter();
    e.recordCurator({ stage: "denial", outcome: "job_not_found" });

    const point = metricsByName(e).curator_stages_total.sum?.dataPoints[0] as unknown as {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    };
    const scope = point.attributes.find((attribute) => attribute.key === "scope");

    expect(scope?.value.stringValue).toBe("unknown");
  });

  // Zero effects is the normal shape of a settlement that kept nothing, and an emitted zero would
  // create a permanently flat series that hides the moment real effects start arriving.
  it("adds no effect series when a settlement recorded and rejected nothing", () => {
    const e = exporter();
    e.recordCurator({
      stage: "settle",
      scope: "business",
      outcome: "settled",
      recorded: 0,
      rejected: 0,
    });

    expect(metricsByName(e).curator_effects_total).toBeUndefined();
  });

  it("POSTs OTLP JSON with basic auth to /v1/metrics", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const e = exporter(fetchMock as unknown as typeof fetch);
    e.recordTurn({ status: "ok" });
    await e.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://otlp.grafana.net/otlp/v1/metrics");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("123:tok").toString("base64")}`
    );
    expect(JSON.parse(init.body as string).resourceMetrics).toBeDefined();
  });

  it("skips the POST when nothing has been recorded", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const e = exporter(fetchMock as unknown as typeof fetch);
    await e.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
