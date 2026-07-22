/**
 * Provider-neutral telemetry port.
 *
 * Capability id `telemetry` (optional; see ./capability). Adapters bind to
 * OpenTelemetry or any exporter without leaking provider types across the
 * boundary. Attribute values are restricted to primitives so callers cannot dump
 * payloads or secrets into spans/metrics/logs; errors are recorded by a stable
 * safe `code`, never a raw error carrying a stack or protected content (SPEC §22:
 * "redacting contents and Secrets").
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Span {
  setAttributes(attributes: Attributes): void;
  /** Record a failure by stable safe code — not a raw error object. */
  recordError(code: string): void;
  end(): void;
}

export interface TelemetryPort {
  startSpan(name: string, attributes?: Attributes): Span;
  counter(name: string, value?: number, attributes?: Attributes): void;
  log(level: LogLevel, message: string, attributes?: Attributes): void;
}
