import { type Attributes, redactAttributes, type TelemetryPort } from "@tulipfarm/observability";

export const MEMORY_METRICS = {
  /**
   * One Agent turn assembled with thinner Context than it should have had, because a Context probe
   * failed and fell back to an absence value. Without it a failed probe is indistinguishable from a
   * genuinely empty one and its rate is unmeasured. Labelled by `probe` only.
   */
  contextDegradations: "tulipfarm.memory.context.degradations",
} as const;

export type MemoryTelemetryAttributes = Readonly<Record<string, string | number | boolean>>;
export type MemoryTelemetryPort = TelemetryPort;

export function safeMemoryAttributes(attributes: MemoryTelemetryAttributes): Attributes {
  return redactAttributes(attributes);
}

export function recordMemoryCounter(
  telemetry: MemoryTelemetryPort | undefined,
  name: string,
  value = 1,
  attributes: MemoryTelemetryAttributes = {}
): void {
  if (telemetry === undefined) return;
  try {
    telemetry.counter(name, value, safeMemoryAttributes(attributes));
  } catch {
    // Telemetry must never affect Memory correctness.
  }
}
