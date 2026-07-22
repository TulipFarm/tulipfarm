import { describe, expect, it } from "vitest";
import type { Attributes, Span, TelemetryPort } from "./telemetry";

// A minimal in-memory adapter proves the port is implementable with only safe,
// provider-neutral metadata — no payloads, no secrets, no provider SDK types.
function fakeTelemetry(sink: string[]): TelemetryPort {
  const span = (name: string): Span => ({
    setAttributes: (a: Attributes) => sink.push(`attr:${name}:${Object.keys(a).join(",")}`),
    recordError: (code: string) => sink.push(`err:${name}:${code}`),
    end: () => sink.push(`end:${name}`),
  });
  return {
    startSpan: (name) => span(name),
    counter: (name, value = 1) => sink.push(`counter:${name}:${value}`),
    log: (level, message) => sink.push(`log:${level}:${message}`),
  };
}

describe("TelemetryPort", () => {
  it("records spans, counters, and logs through safe metadata only", () => {
    const sink: string[] = [];
    const t = fakeTelemetry(sink);
    const s = t.startSpan("run.dispatch", { runId: "r1" });
    s.setAttributes({ stateId: "s1" });
    s.recordError("tool_timeout");
    s.end();
    t.counter("runs.dispatched");
    t.log("info", "dispatched");
    expect(sink).toEqual([
      "attr:run.dispatch:stateId",
      "err:run.dispatch:tool_timeout",
      "end:run.dispatch",
      "counter:runs.dispatched:1",
      "log:info:dispatched",
    ]);
  });
});
