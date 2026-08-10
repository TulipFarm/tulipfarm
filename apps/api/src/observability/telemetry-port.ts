import {
  type Attributes,
  redactAttributes,
  type Span,
  type TelemetryPort,
} from "@tulipfarm/observability";
import type { ObservabilityService } from "./service";

function fireAndForget(promise: Promise<unknown>): void {
  promise.catch((error) =>
    console.error(
      `[observability] telemetry write failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  );
}

function safe(attributes: Attributes | undefined): Attributes {
  return redactAttributes(attributes ?? {});
}

export function createObservabilityTelemetryPort(obs: ObservabilityService): TelemetryPort {
  function recordMetric(
    kind: "counter" | "histogram" | "gauge",
    name: string,
    value: number,
    attributes?: Attributes
  ): void {
    fireAndForget(
      obs.record({
        type: "job",
        status: "ok",
        toolName: name,
        attributes: {
          metric_kind: kind,
          value,
          ...safe(attributes),
        },
      })
    );
  }

  return {
    startSpan(name, attributes = {}) {
      const startedAt = Date.now();
      let ended = false;
      let status = "ok";
      let current = safe(attributes);
      const span: Span = {
        setAttributes(next) {
          current = { ...current, ...safe(next) };
        },
        recordError(code) {
          status = "error";
          current = { ...current, error_code: code };
        },
        end() {
          if (ended) return;
          ended = true;
          fireAndForget(
            obs.record({
              type: "job",
              status,
              toolName: name,
              durationMs: Date.now() - startedAt,
              attributes: current,
            })
          );
        },
      };
      return span;
    },
    counter(name, value = 1, attributes) {
      recordMetric("counter", name, value, attributes);
    },
    histogram(name, value, attributes) {
      recordMetric("histogram", name, value, attributes);
    },
    gauge(name, value, attributes) {
      recordMetric("gauge", name, value, attributes);
    },
    log(level, message, attributes) {
      fireAndForget(
        obs.record({
          type: "job",
          status: level === "error" ? "error" : "ok",
          toolName: "telemetry.log",
          // The message is the whole point of a log line. Persisting only the level (as this did)
          // recorded that something happened while discarding what it was.
          attributes: { level, message, ...safe(attributes) },
        })
      );
    },
  };
}
