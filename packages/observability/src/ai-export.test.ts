import { describe, expect, it, vi } from "vitest";
import { OtlpAiMetricsExporter, OtlpAiTracesExporter } from "./ai-export";

const TARGET = {
  endpoint: "https://otlp.example.test/otlp",
  instanceId: "123",
  token: "resolved-token",
};

describe("Worker AI OTLP exporters", () => {
  it("exports fallback and Tool outcomes as bounded metric labels", () => {
    const exporter = new OtlpAiMetricsExporter(TARGET, () => 1000);
    exporter.recordLlmCall({
      model: "fallback-model",
      provider: "provider-2",
      status: "fallback",
      tokensIn: 10,
      tokensOut: 2,
      costUsd: 0.1,
    });
    exporter.recordToolCall({ toolName: "send_message", status: "error" });
    exporter.recordTurn({ status: "ok" });

    const json = JSON.stringify(exporter.buildPayload());
    expect(json).toContain("fallback");
    expect(json).toContain("send_message");
    expect(json).not.toContain("arguments");
    expect(json).not.toContain("result");
  });

  it("uses the durable trace id supplied by the Worker for the root and child spans", () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const exporter = new OtlpAiTracesExporter(
      TARGET,
      () => 1000,
      () => 0.5
    );
    exporter.spanStep("run-1", {
      traceId,
      name: "model",
      kind: "llm_call",
      status: "ok",
      attributes: {},
    });
    exporter.finishTurn("run-1", {
      traceId,
      agentId: "support",
      status: "ok",
      steps: 1,
      tokensIn: 10,
      tokensOut: 2,
    });

    const json = JSON.stringify(exporter.buildPayload());
    expect(json.match(new RegExp(traceId, "g"))).toHaveLength(2);
  });

  it("keeps a trace batch when the exporter transport fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const exporter = new OtlpAiTracesExporter(
      TARGET,
      () => 1000,
      () => 0.5,
      fetch as never
    );
    exporter.finishTurn("run-1", {
      traceId: "0123456789abcdef0123456789abcdef",
      agentId: null,
      status: "error",
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    await exporter.flush();

    expect(exporter.buildPayload().resourceSpans).toHaveLength(1);
  });

  it("keeps a trace batch when the collector rejects it", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const exporter = new OtlpAiTracesExporter(
      TARGET,
      () => 1000,
      () => 0.5,
      fetch
    );
    exporter.finishTurn("run-1", {
      traceId: "0123456789abcdef0123456789abcdef",
      agentId: null,
      status: "error",
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    await exporter.flush();

    expect(exporter.buildPayload().resourceSpans).toHaveLength(1);
  });

  it("flushes metrics to the configured OTLP endpoint", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const exporter = new OtlpAiMetricsExporter(TARGET, () => 1000, fetch);
    exporter.recordTurn({ status: "ok" });

    await exporter.flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://otlp.example.test/otlp/v1/metrics",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Basic /),
          "content-type": "application/json",
        }),
      })
    );
  });

  it("removes a trace batch after the collector accepts it", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const exporter = new OtlpAiTracesExporter(
      TARGET,
      () => 1000,
      () => 0.5,
      fetch
    );
    exporter.finishTurn("run-1", {
      traceId: "0123456789abcdef0123456789abcdef",
      agentId: "support",
      status: "ok",
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    await exporter.flush();

    expect(fetch).toHaveBeenCalledWith(
      "https://otlp.example.test/otlp/v1/traces",
      expect.objectContaining({ method: "POST" })
    );
    expect(exporter.buildPayload().resourceSpans).toEqual([]);
  });
});
