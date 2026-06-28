import { describe, expect, it } from "vitest";
import { DEFAULT_OBSERVABILITY_CONFIG, parseObservabilityConfig } from "./config";

describe("parseObservabilityConfig", () => {
  it("returns disabled defaults for null / missing config (zero setup)", () => {
    expect(parseObservabilityConfig(null)).toEqual(DEFAULT_OBSERVABILITY_CONFIG);
    expect(parseObservabilityConfig(undefined)).toEqual(DEFAULT_OBSERVABILITY_CONFIG);
  });

  it("parses a full config, mapping snake_case to camelCase", () => {
    const cfg = parseObservabilityConfig({
      enabled: true,
      retention_days: 30,
      capture_content: true,
      spend_alert_usd: 50,
      otlp: {
        endpoint: "https://otlp.grafana.net/otlp",
        instance_id: "123456",
        token: "env://GRAFANA_OTLP_TOKEN",
      },
      pricing_overrides: { "my-model": { in: 1, out: 3 } },
    });
    expect(cfg).toEqual({
      enabled: true,
      retentionDays: 30,
      captureContent: true,
      spendAlertUsd: 50,
      otlp: {
        endpoint: "https://otlp.grafana.net/otlp",
        instanceId: "123456",
        token: "env://GRAFANA_OTLP_TOKEN",
      },
      pricingOverrides: { "my-model": { in: 1, out: 3 } },
    });
  });

  it("drops an incomplete otlp block and malformed price overrides", () => {
    const cfg = parseObservabilityConfig({
      enabled: true,
      otlp: { endpoint: "https://x", instance_id: "1" }, // missing token
      pricing_overrides: { good: { in: 1, out: 2 }, bad: { in: "x" } },
    });
    expect(cfg.otlp).toBeNull();
    expect(cfg.pricingOverrides).toEqual({ good: { in: 1, out: 2 } });
    expect(cfg.retentionDays).toBe(90); // default preserved
  });
});
