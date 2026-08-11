import { describe, expect, it } from "vitest";
import { TulipFarmValidationError } from "./error";
import { validateSoulConfig } from "./soul-config";

const validLlm = {
  tiers: {
    quick: {
      providers: [{ provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "key" }],
    },
    standard: {
      providers: [{ provider: "anthropic", model: "claude-sonnet-4-6", api_key_ref: "key" }],
    },
    complex: {
      providers: [{ provider: "anthropic", model: "claude-opus-4-8", api_key_ref: "key" }],
    },
  },
};

describe("validateSoulConfig", () => {
  it("accepts a freshly scaffolded empty soul.yaml document", () => {
    expect(validateSoulConfig({})).toEqual({});
  });

  it("accepts the fields read from soul.yaml today", () => {
    const config = validateSoulConfig({
      soulFormatVersion: 2,
      businessName: "Tulip Farm",
      businessDescription: "AI-native operations",
      businessWebsite: "https://example.com",
      setupComplete: true,
      gitRemoteUrl: "git@example.com:tulip/soul.git",
      llm: validLlm,
      futureKey: { remains: "allowed" },
    });

    expect(config).toMatchObject({
      soulFormatVersion: 2,
      businessName: "Tulip Farm",
      setupComplete: true,
      llm: validLlm,
    });
  });

  it("rejects malformed fields with a useful validation path", () => {
    expect(() => validateSoulConfig({ setupComplete: "yes" })).toThrow(
      new TulipFarmValidationError("soul", "/setupComplete", "must be boolean")
    );
  });

  it("rejects invalid nested llm config", () => {
    expect(() => validateSoulConfig({ llm: {} })).toThrow(
      "config must declare provider chains in tiers"
    );
  });
});
