import type { ModelPrice } from "@tulipfarm/llm";
import { assertValidSecretKey, InvalidSecretKeyError } from "@tulipfarm/secrets";
import { stringify as stringifyYaml } from "yaml";

/** Observability config; OTLP `token` resolves at exporter setup, not parse time. */
export interface ObservabilityConfig {
  /** Master switch for the Grafana Cloud OTLP export. Off ⇒ no OTel deps loaded, no push. */
  enabled: boolean;
  /** Raw-event retention window (days) for the prune job. */
  retentionDays: number;
  /** When true, prompt/completion/tool bodies may be captured (P3). Off by default. */
  captureContent: boolean;
  /**
   * Rolling-24h model spend ceiling in USD; null ⇒ no alert.
   *
   * Enforced by the instance: the API schedules an hourly check and the Worker reports a breach
   * to the operator log. It needs no Grafana. The shipped Grafana rule carries its own threshold
   * and is an optional second route for the same breach, not the thing that makes this work.
   */
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

export interface ObservabilityConfigWrite {
  enabled: boolean;
  retentionDays: number;
  captureContent: boolean;
  spendAlertUsd: number | null;
  otlp: {
    endpoint: string;
    instanceId: string;
    /** Omit to keep the currently saved reference; plaintext is never accepted. */
    tokenRef?: string;
  } | null;
  pricingOverrides: Record<string, ModelPrice>;
}

export type ObservabilityConfigValidation =
  | { ok: true; config: ObservabilityConfig }
  | { ok: false; path: string; error: string };

const ENV_REF = /^env:\/\/[A-Z_][A-Z0-9_]*$/;
const SECRET_REF = /^secret:\/\/[A-Za-z0-9._-]+$/;

function invalid(path: string, error: string): ObservabilityConfigValidation {
  return { ok: false, path, error };
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

/** Strict authoring validation. Unlike the boot parser, this rejects every malformed field. */
export function validateObservabilityConfigWrite(
  input: ObservabilityConfigWrite,
  existingToken: string | null
): ObservabilityConfigValidation {
  if (
    !Number.isInteger(input.retentionDays) ||
    input.retentionDays < 1 ||
    input.retentionDays > 3650
  ) {
    return invalid("/retentionDays", "Retention must be an integer from 1 to 3650 days");
  }
  if (
    input.spendAlertUsd !== null &&
    (!Number.isFinite(input.spendAlertUsd) || input.spendAlertUsd < 0)
  ) {
    return invalid("/spendAlertUsd", "Spend alert must be zero or greater");
  }

  let otlp: ObservabilityConfig["otlp"] = null;
  if (input.otlp !== null) {
    const endpoint = input.otlp.endpoint.trim();
    const instanceId = input.otlp.instanceId.trim();
    if (!validEndpoint(endpoint)) {
      return invalid("/otlp/endpoint", "OTLP endpoint must be an HTTP or HTTPS URL");
    }
    if (instanceId.length === 0 || instanceId.length > 256) {
      return invalid("/otlp/instanceId", "OTLP instance ID is required");
    }
    const retainedToken =
      existingToken !== null && !existingToken.includes("://")
        ? `secret://${existingToken}`
        : existingToken;
    const token = input.otlp.tokenRef?.trim() || retainedToken;
    if (token === null) {
      return invalid("/otlp/tokenRef", "OTLP token reference is required");
    }
    if (!ENV_REF.test(token) && !SECRET_REF.test(token)) {
      return invalid("/otlp/tokenRef", "OTLP token must be an env:// or secret:// reference");
    }
    if (SECRET_REF.test(token)) {
      try {
        assertValidSecretKey(token.slice("secret://".length));
      } catch (error) {
        if (error instanceof InvalidSecretKeyError) {
          return invalid("/otlp/tokenRef", error.message);
        }
        throw error;
      }
    }
    otlp = { endpoint, instanceId, token };
  }

  const pricingOverrides: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(input.pricingOverrides)) {
    if (model.trim().length === 0) {
      return invalid("/pricingOverrides", "Model names must not be empty");
    }
    if (!Number.isFinite(price.in) || price.in < 0) {
      return invalid(`/pricingOverrides/${model}/in`, "Input price must be zero or greater");
    }
    if (!Number.isFinite(price.out) || price.out < 0) {
      return invalid(`/pricingOverrides/${model}/out`, "Output price must be zero or greater");
    }
    pricingOverrides[model] = { in: price.in, out: price.out };
  }

  return {
    ok: true,
    config: {
      enabled: input.enabled,
      retentionDays: input.retentionDays,
      captureContent: input.captureContent,
      spendAlertUsd: input.spendAlertUsd,
      otlp,
      pricingOverrides,
    },
  };
}

/** Canonical authored shape for `observability.config.yaml`. */
export function yamlForObservabilityConfig(config: ObservabilityConfig): string {
  return stringifyYaml({
    enabled: config.enabled,
    retention_days: config.retentionDays,
    capture_content: config.captureContent,
    spend_alert_usd: config.spendAlertUsd,
    otlp:
      config.otlp === null
        ? null
        : {
            endpoint: config.otlp.endpoint,
            instance_id: config.otlp.instanceId,
            token: config.otlp.token,
          },
    pricing_overrides: config.pricingOverrides,
  });
}

/** Return the environment key only for an approved environment reference. */
export function observabilityEnvKey(ref: string): string | undefined {
  return ENV_REF.test(ref) ? ref.slice("env://".length) : undefined;
}

/** Resolve explicit Secret references and legacy bare keys at exporter startup. */
export function observabilitySecretKey(ref: string): string | undefined {
  const key = ref.startsWith("secret://") ? ref.slice("secret://".length) : ref;
  try {
    assertValidSecretKey(key);
    return key;
  } catch (error) {
    if (error instanceof InvalidSecretKeyError) return undefined;
    throw error;
  }
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Parses raw YAML (or null) into defaults. Lenient: bad fields are dropped. */
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
