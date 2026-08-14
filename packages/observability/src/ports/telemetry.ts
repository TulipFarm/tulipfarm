/** Telemetry port restricts attributes to primitives and records safe error codes, never raw errors. */

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
  histogram?(name: string, value: number, attributes?: Attributes): void;
  gauge?(name: string, value: number, attributes?: Attributes): void;
  log(level: LogLevel, message: string, attributes?: Attributes): void;
}
