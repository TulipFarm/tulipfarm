import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCost, formatTokens, updateObservabilityConfig } from "./observability";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatCost", () => {
  it("formats normal amounts to cents", () => {
    expect(formatCost(42.18)).toBe("$42.18");
  });
  it("shows extra precision for sub-cent spend so it isn't $0.00", () => {
    expect(formatCost(0.0004)).toBe("$0.0004");
  });
  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });
  it("formats a non-USD currency code", () => {
    expect(formatCost(42.18, "INR")).toBe("₹42.18");
  });
});

describe("formatTokens", () => {
  it("compacts millions and thousands", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(4_500)).toBe("4.5k");
  });
  it("leaves small counts as-is", () => {
    expect(formatTokens(320)).toBe("320");
  });
});

describe("updateObservabilityConfig", () => {
  it("uses the authenticated JSON write path with the stale Soul base", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        commitSha: "next-sha",
        published: true,
        exporterActive: false,
        restartRequired: true,
      })
    );
    vi.stubGlobal("fetch", fetch);

    await updateObservabilityConfig({
      baseCommit: "base-sha",
      enabled: true,
      retentionDays: 30,
      captureContent: false,
      spendAlertUsd: null,
      otlp: {
        endpoint: "https://otlp.example.test/otlp",
        instanceId: "123",
        tokenRef: "secret://grafana-otlp-token",
      },
      pricingOverrides: {},
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4010/api/v1/observability/config",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: expect.stringContaining('"baseCommit":"base-sha"'),
      })
    );
  });
});
