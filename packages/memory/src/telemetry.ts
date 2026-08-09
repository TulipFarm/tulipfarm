import {
  type Attributes,
  redactAttributes,
  type Span,
  type TelemetryPort,
} from "@tulipfarm/observability";

export const MEMORY_METRICS = {
  recallRequests: "tulipfarm.memory.recall.requests",
  recallLatencyMs: "tulipfarm.memory.recall.latency_ms",
  recallResults: "tulipfarm.memory.recall.results",
  recallExclusions: "tulipfarm.memory.recall.exclusions",
  extractionCandidates: "tulipfarm.memory.extraction.candidates",
  extractionScreeningRefusals: "tulipfarm.memory.extraction.screening_refusals",
  confirmationDecisions: "tulipfarm.memory.confirmation.decisions",
  contradictionsDetected: "tulipfarm.memory.contradictions.detected",
  contradictionsInvalidated: "tulipfarm.memory.contradictions.invalidated",
  contradictionsJudgeFailures: "tulipfarm.memory.contradictions.judge_failures",
  forgetOperations: "tulipfarm.memory.forget.operations",
  eraseOperations: "tulipfarm.memory.erase.operations",
  eraseCascadeCounts: "tulipfarm.memory.erase.cascade_counts",
  eraseCascadeFailures: "tulipfarm.memory.erase.cascade_failures",
  pendingDepth: "tulipfarm.memory.pending.depth",
  pendingOldestAgeMs: "tulipfarm.memory.pending.oldest_age_ms",
  assertionWrites: "tulipfarm.memory.assertions.writes",
  episodeWrites: "tulipfarm.memory.episodes.writes",
  episodeAccess: "tulipfarm.memory.episodes.access",
  episodeChunks: "tulipfarm.memory.episodes.chunks",
  episodeRecallCandidates: "tulipfarm.memory.episodes.recall_candidates",
} as const;

export const MEMORY_SPANS = {
  recall: "tulipfarm.memory.recall",
  extraction: "tulipfarm.memory.extraction",
  confirmation: "tulipfarm.memory.confirmation",
  contradiction: "tulipfarm.memory.contradiction",
  forget: "tulipfarm.memory.forget",
  erase: "tulipfarm.memory.erase",
  episodeWrite: "tulipfarm.memory.episode.write",
  episodeRecall: "tulipfarm.memory.episode.recall",
} as const;

const NOOP_SPAN: Span = {
  setAttributes: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

export type MemoryTelemetryAttributes = Readonly<Record<string, string | number | boolean>>;
export type MemoryTelemetryPort = TelemetryPort;

export function safeMemoryAttributes(attributes: MemoryTelemetryAttributes): Attributes {
  return redactAttributes(attributes);
}

export function startMemorySpan(
  telemetry: MemoryTelemetryPort | undefined,
  name: string,
  attributes: MemoryTelemetryAttributes = {}
): Span {
  if (telemetry === undefined) return NOOP_SPAN;
  try {
    return telemetry.startSpan(name, safeMemoryAttributes(attributes));
  } catch {
    return NOOP_SPAN;
  }
}

export function setMemorySpanAttributes(span: Span, attributes: MemoryTelemetryAttributes): void {
  try {
    span.setAttributes(safeMemoryAttributes(attributes));
  } catch {
    // Telemetry must never affect Memory correctness.
  }
}

export function recordMemorySpanError(span: Span, code: string): void {
  try {
    span.recordError(code);
  } catch {
    // Telemetry must never affect Memory correctness.
  }
}

export function endMemorySpan(span: Span): void {
  try {
    span.end();
  } catch {
    // Telemetry must never affect Memory correctness.
  }
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

export function recordMemoryHistogram(
  telemetry: MemoryTelemetryPort | undefined,
  name: string,
  value: number,
  attributes: MemoryTelemetryAttributes = {}
): void {
  if (telemetry === undefined || !Number.isFinite(value)) return;
  try {
    if (telemetry.histogram !== undefined) {
      telemetry.histogram(name, value, safeMemoryAttributes(attributes));
    } else {
      telemetry.counter(name, value, safeMemoryAttributes(attributes));
    }
  } catch {
    // Telemetry must never affect Memory correctness.
  }
}

export function recordMemoryGauge(
  telemetry: MemoryTelemetryPort | undefined,
  name: string,
  value: number,
  attributes: MemoryTelemetryAttributes = {}
): void {
  if (telemetry === undefined || !Number.isFinite(value)) return;
  try {
    if (telemetry.gauge !== undefined) {
      telemetry.gauge(name, value, safeMemoryAttributes(attributes));
    } else {
      telemetry.counter(name, value, safeMemoryAttributes(attributes));
    }
  } catch {
    // Telemetry must never affect Memory correctness.
  }
}
