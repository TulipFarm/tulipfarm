import { describe, expect, it, vi } from "vitest";
import { OtlpTracesExporter } from "./traces";

const TARGET = { endpoint: "https://otlp.grafana.net/otlp", instanceId: "123", token: "tok" };

// Deterministic rand so trace/span ids are stable.
function exporter(fetchImpl?: typeof fetch) {
  return new OtlpTracesExporter(
    TARGET,
    () => 1_700_000_000_000,
    () => 0.5,
    fetchImpl ?? (vi.fn() as never)
  );
}

describe("OtlpTracesExporter", () => {
  it("builds one trace per turn: a root turn span with child step spans sharing the trace id", () => {
    const e = exporter();
    e.spanStep("conv-1", {
      name: "claude-opus-4-8",
      kind: "llm_call",
      durationMs: 1200,
      status: "ok",
      attributes: { "tulipfarm.provider": "anthropic" },
    });
    e.spanStep("conv-1", { name: "search", kind: "tool_call", status: "ok", attributes: {} });
    e.finishTurn("conv-1", {
      agentId: "support-agent",
      status: "ok",
      durationMs: 2000,
      steps: 1,
      tokensIn: 100,
      tokensOut: 50,
    });

    const payload = e.buildPayload() as {
      resourceSpans: [
        {
          scopeSpans: [{ spans: Array<{ traceId: string; parentSpanId?: string; name: string }> }];
        },
      ];
    };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(3); // turn + 2 children
    const root = spans.find((s) => s.name === "turn");
    expect(root?.parentSpanId).toBeUndefined();
    // All spans share one trace id; children parent to the root.
    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
    for (const child of spans.filter((s) => s.name !== "turn")) {
      expect(child.parentSpanId).toBeDefined();
    }
  });

  it("maps only genuine failures to OTLP ERROR — fallback is not an error", () => {
    const e = exporter();
    e.spanStep("c", { name: "m1", kind: "llm_call", status: "fallback", attributes: {} });
    e.spanStep("c", { name: "t1", kind: "tool_call", status: "error", attributes: {} });
    e.finishTurn("c", { agentId: "a", status: "ok", steps: 2, tokensIn: 0, tokensOut: 0 });
    const payload = e.buildPayload() as {
      resourceSpans: [
        { scopeSpans: [{ spans: Array<{ name: string; status: { code: number } }> }] },
      ];
    };
    const byName = Object.fromEntries(
      payload.resourceSpans[0].scopeSpans[0].spans.map((s) => [s.name, s.status.code])
    );
    expect(byName.turn).toBe(0); // ok → UNSET
    expect(byName.m1).toBe(0); // fallback → UNSET (not an error)
    expect(byName.t1).toBe(2); // error → ERROR
  });

  it("survives non-finite durations without throwing (BigInt guard)", () => {
    const e = exporter();
    expect(() =>
      e.spanStep("c", {
        name: "m",
        kind: "llm_call",
        durationMs: Number.NaN,
        status: "ok",
        attributes: {},
      })
    ).not.toThrow();
    expect(() =>
      e.finishTurn("c", {
        agentId: "a",
        status: "ok",
        durationMs: Number.POSITIVE_INFINITY,
        steps: 1,
        tokensIn: 0,
        tokensOut: 0,
      })
    ).not.toThrow();
  });

  it("scopes accumulated spans per conversation", () => {
    const e = exporter();
    e.spanStep("conv-a", { name: "m", kind: "llm_call", status: "ok", attributes: {} });
    e.spanStep("conv-b", { name: "m", kind: "llm_call", status: "ok", attributes: {} });
    // Finishing conv-a must only include conv-a's child, not conv-b's.
    e.finishTurn("conv-a", {
      agentId: "a",
      status: "ok",
      steps: 1,
      tokensIn: 0,
      tokensOut: 0,
    });
    const payload = e.buildPayload() as {
      resourceSpans: [{ scopeSpans: [{ spans: unknown[] }] }];
    };
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2); // turn + 1 child
  });

  it("POSTs OTLP trace JSON with basic auth to /v1/traces, then clears the buffer", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const e = exporter(fetchMock as unknown as typeof fetch);
    e.finishTurn("c", { agentId: "a", status: "ok", steps: 0, tokensIn: 0, tokensOut: 0 });
    await e.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://otlp.grafana.net/otlp/v1/traces");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("123:tok").toString("base64")}`
    );
    // Buffer cleared after a successful flush.
    expect(e.buildPayload().resourceSpans).toHaveLength(0);
  });
});
