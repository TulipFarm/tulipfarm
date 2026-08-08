import { describe, expect, it } from "vitest";
import { LlmConfigValidationError, validateLlmConfig } from "./llm";

const validConfig = {
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

describe("validateLlmConfig", () => {
  it("accepts valid config", () => {
    const result = validateLlmConfig(validConfig);
    expect(result.tiers?.quick.providers[0]?.provider).toBe("anthropic");
  });

  it("rejects missing tiers", () => {
    expect(() => validateLlmConfig({})).toThrow(LlmConfigValidationError);
  });

  it("accepts a config that declares presets instead of tiers", () => {
    // Either side of the ModelProfile migration must validate; only naming neither is an error.
    expect(() => validateLlmConfig({ presets: { default: "balanced" } })).not.toThrow();
  });

  it("rejects empty providers array", () => {
    const bad = {
      tiers: { ...validConfig.tiers, quick: { providers: [] } },
    };
    expect(() => validateLlmConfig(bad)).toThrow(LlmConfigValidationError);
  });

  it("rejects missing required tier", () => {
    const { quick: _q, ...noQuick } = validConfig.tiers;
    expect(() => validateLlmConfig({ tiers: noQuick })).toThrow(LlmConfigValidationError);
  });

  it("allows optional api_key_ref and base_url to be absent", () => {
    const config = {
      tiers: {
        ...validConfig.tiers,
        quick: { providers: [{ provider: "openai", model: "gpt-4o" }] },
      },
    };
    expect(() => validateLlmConfig(config)).not.toThrow();
  });

  it("rejects an empty model id", () => {
    const bad = {
      tiers: {
        ...validConfig.tiers,
        quick: { providers: [{ provider: "anthropic", model: "" }] },
      },
    };
    expect(() => validateLlmConfig(bad)).toThrow(LlmConfigValidationError);
  });

  it("rejects a model id containing whitespace", () => {
    const bad = {
      tiers: {
        ...validConfig.tiers,
        quick: { providers: [{ provider: "anthropic", model: "claude opus" }] },
      },
    };
    expect(() => validateLlmConfig(bad)).toThrow(LlmConfigValidationError);
  });

  it("accepts an org-prefixed model id", () => {
    const config = {
      tiers: {
        ...validConfig.tiers,
        quick: { providers: [{ provider: "openai-compatible", model: "meta-llama/Llama-3.1-8B" }] },
      },
    };
    expect(() => validateLlmConfig(config)).not.toThrow();
  });
});
