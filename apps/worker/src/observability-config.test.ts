import { describe, expect, it, vi } from "vitest";
import { resolveWorkerOtlpTarget } from "./observability-config";

const config = (token: string) => ({
  enabled: true,
  retentionDays: 30,
  captureContent: false,
  spendAlertUsd: null,
  otlp: {
    endpoint: "https://otlp.example.test/otlp",
    instanceId: "123",
    token,
  },
  pricingOverrides: {},
});

describe("resolveWorkerOtlpTarget", () => {
  it("resolves an approved environment reference", async () => {
    await expect(
      resolveWorkerOtlpTarget(config("env://GRAFANA_OTLP_TOKEN"), {
        env: { GRAFANA_OTLP_TOKEN: "env-token" },
        secret: vi.fn(),
      })
    ).resolves.toEqual({
      endpoint: "https://otlp.example.test/otlp",
      instanceId: "123",
      token: "env-token",
    });
  });

  it("strips an approved Secret reference before reading it", async () => {
    const secret = vi.fn(async () => "stored-token");

    await expect(
      resolveWorkerOtlpTarget(config("secret://grafana-otlp-token"), {
        env: {},
        secret,
      })
    ).resolves.toEqual({
      endpoint: "https://otlp.example.test/otlp",
      instanceId: "123",
      token: "stored-token",
    });
    expect(secret).toHaveBeenCalledWith("grafana-otlp-token");
  });

  it.each(["env://lower-case", "secret://__proto__", "plaintext-token"])(
    "rejects an unapproved token reference: %s",
    async (token) => {
      const secret = vi.fn(async () => "stored-token");

      await expect(
        resolveWorkerOtlpTarget(config(token), {
          env: {},
          secret,
        })
      ).resolves.toBeUndefined();
      expect(secret).not.toHaveBeenCalled();
    }
  );
});
