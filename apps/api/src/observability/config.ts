import type { ModelPrice } from "@tulipfarm/llm";

/**
 * Runtime observability config, parsed from `soul/observability.config.yaml` (all fields optional;
 * an absent file ⇒ disabled defaults, zero setup). The OTLP `token` is an `env://VAR` / secret ref
 * resolved at exporter-setup time, not here. snake_case YAML → camelCase here.
 */
export interface ObservabilityConfig {
  /** Master switch for the Grafana Cloud OTLP export. Off ⇒ no OTel deps loaded, no push. */
  enabled: boolean;
  /** Raw-event retention window (days) for the prune job. */
  retentionDays: number;
  /** When true, prompt/completion/tool bodies may be captured (P3). Off by default. */
  captureContent: boolean;
  /** Daily-spend threshold ($) used by the shipped Grafana alert rule; null ⇒ unset. */
  spendAlertUsd: number | null;
  /** Grafana Cloud OTLP target; null ⇒ no exporter even if `enabled`. `token` is a ref string. */
  otlp: { endpoint: string; instanceId: string; token: string } | null;
  /** Per-model price overrides merged over the built-in map (USD per 1M tokens). */
  pricingOverrides: Record<string, ModelPrice>;
}

export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enabled: false,
  retentionDays: 90,
  captureContent: false,
  spendAlertUsd: null,
  otlp: null,
  pricingOverrides: {},
};

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Parse + coerce raw YAML (or null) into a fully-defaulted config. Lenient: bad fields are dropped. */
export function parseObservabilityConfig(raw: unknown): ObservabilityConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_OBSERVABILITY_CONFIG };
  const r = raw as Record<string, unknown>;

  const otlpRaw = r.otlp as Record<string, unknown> | undefined;
  const otlp =
    otlpRaw &&
    typeof otlpRaw.endpoint === "string" &&
    typeof otlpRaw.instance_id === "string" &&
    typeof otlpRaw.token === "string"
      ? { endpoint: otlpRaw.endpoint, instanceId: otlpRaw.instance_id, token: otlpRaw.token }
      : null;

  const pricingOverrides: Record<string, ModelPrice> = {};
  if (r.pricing_overrides && typeof r.pricing_overrides === "object") {
    for (const [k, v] of Object.entries(r.pricing_overrides as Record<string, unknown>)) {
      const p = v as Record<string, unknown>;
      if (typeof p?.in === "number" && typeof p?.out === "number") {
        pricingOverrides[k] = { in: p.in, out: p.out };
      }
    }
  }

  return {
    enabled: r.enabled === true,
    // Clamp to ≥1: a 0/negative window would make the prune cutoff `now`, deleting every event.
    retentionDays: Math.max(1, Math.floor(asNumber(r.retention_days, 90))),
    captureContent: r.capture_content === true,
    spendAlertUsd: typeof r.spend_alert_usd === "number" ? r.spend_alert_usd : null,
    otlp,
    pricingOverrides,
  };
}
