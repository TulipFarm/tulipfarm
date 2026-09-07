import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_OBSERVABILITY_CONFIG,
  observabilityEnvKey,
  observabilitySecretKey,
  parseObservabilityConfig,
  validateObservabilityConfigWrite,
  yamlForObservabilityConfig,
} from "./config";

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

  describe("validateObservabilityConfigWrite", () => {
    const valid = {
      enabled: true,
      retentionDays: 30,
      captureContent: false,
      spendAlertUsd: 50,
      otlp: {
        endpoint: "https://otlp.grafana.net/otlp",
        instanceId: "123456",
        tokenRef: "secret://grafana-otlp-token",
      },
      pricingOverrides: { "my-model": { in: 1, out: 3 } },
    };

    it("accepts only a Secret or environment reference for the OTLP token", () => {
      expect(validateObservabilityConfigWrite(valid, null)).toEqual({
        ok: true,
        config: {
          ...valid,
          otlp: {
            endpoint: valid.otlp.endpoint,
            instanceId: valid.otlp.instanceId,
            token: valid.otlp.tokenRef,
          },
        },
      });

      expect(
        validateObservabilityConfigWrite(
          { ...valid, otlp: { ...valid.otlp, tokenRef: "glc_plaintext-token" } },
          null
        )
      ).toEqual({
        ok: false,
        path: "/otlp/tokenRef",
        error: "OTLP token must be an env:// or secret:// reference",
      });
      expect(
        validateObservabilityConfigWrite(
          { ...valid, otlp: { ...valid.otlp, tokenRef: "secret://constructor" } },
          null
        )
      ).toMatchObject({ ok: false, path: "/otlp/tokenRef" });
    });

    it("resolves explicit references and existing bare Secret keys", () => {
      expect(observabilityEnvKey("env://GRAFANA_OTLP_TOKEN")).toBe("GRAFANA_OTLP_TOKEN");
      expect(observabilitySecretKey("secret://grafana-otlp-token")).toBe("grafana-otlp-token");
      expect(observabilityEnvKey("env://not-approved")).toBeUndefined();
      expect(observabilitySecretKey("grafana-otlp-token")).toBe("grafana-otlp-token");
      expect(observabilitySecretKey("https://example.test/token")).toBeUndefined();
      expect(observabilitySecretKey("secret://constructor")).toBeUndefined();
    });

    it("preserves the existing token reference when the form leaves it blank", () => {
      const result = validateObservabilityConfigWrite(
        { ...valid, otlp: { endpoint: valid.otlp.endpoint, instanceId: valid.otlp.instanceId } },
        "env://GRAFANA_OTLP_TOKEN"
      );

      expect(result).toMatchObject({
        ok: true,
        config: { otlp: { token: "env://GRAFANA_OTLP_TOKEN" } },
      });
    });

    it("normalizes a retained legacy Secret key without accepting new bare token references", () => {
      expect(
        validateObservabilityConfigWrite(
          { ...valid, otlp: { endpoint: valid.otlp.endpoint, instanceId: valid.otlp.instanceId } },
          "grafana-otlp-token"
        )
      ).toMatchObject({
        ok: true,
        config: { otlp: { token: "secret://grafana-otlp-token" } },
      });
      expect(
        validateObservabilityConfigWrite(
          { ...valid, otlp: { ...valid.otlp, tokenRef: "grafana-otlp-token" } },
          null
        )
      ).toMatchObject({ ok: false, path: "/otlp/tokenRef" });
    });

    it("rejects invalid bounds, endpoints, and price overrides instead of dropping them", () => {
      expect(validateObservabilityConfigWrite({ ...valid, retentionDays: 0 }, null)).toMatchObject({
        ok: false,
        path: "/retentionDays",
      });
      expect(
        validateObservabilityConfigWrite(
          { ...valid, otlp: { ...valid.otlp, endpoint: "file:///secret" } },
          null
        )
      ).toMatchObject({ ok: false, path: "/otlp/endpoint" });
      expect(
        validateObservabilityConfigWrite(
          { ...valid, otlp: { ...valid.otlp, endpoint: "https://:password@example.test/otlp" } },
          null
        )
      ).toMatchObject({ ok: false, path: "/otlp/endpoint" });
      expect(
        validateObservabilityConfigWrite(
          { ...valid, pricingOverrides: { bad: { in: -1, out: 2 } } },
          null
        )
      ).toMatchObject({ ok: false, path: "/pricingOverrides/bad/in" });
    });

    it("serializes the strict config back to the snake-case Soul contract", () => {
      const checked = validateObservabilityConfigWrite(valid, null);
      if (!checked.ok) throw new Error(checked.error);

      expect(parseYaml(yamlForObservabilityConfig(checked.config))).toEqual({
        enabled: true,
        retention_days: 30,
        capture_content: false,
        spend_alert_usd: 50,
        otlp: {
          endpoint: "https://otlp.grafana.net/otlp",
          instance_id: "123456",
          token: "secret://grafana-otlp-token",
        },
        pricing_overrides: { "my-model": { in: 1, out: 3 } },
      });
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
