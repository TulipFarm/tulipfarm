import { describe, expect, it, vi } from "vitest";
import { OtlpMetricsExporter } from "./metrics";

const TARGET = { endpoint: "https://otlp.grafana.net/otlp", instanceId: "123", token: "tok" };

function exporter(fetchImpl?: typeof fetch) {
  return new OtlpMetricsExporter(TARGET, () => 1_700_000_000_000, fetchImpl ?? (vi.fn() as never));
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
