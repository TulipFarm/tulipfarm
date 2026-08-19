import { describe, expect, it } from "vitest";
import { dropUnusableProviderEntries, LlmConfigValidationError, validateLlmConfig } from "./llm";

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

  it("rejects Effort Presets without provider chains", () => {
    expect(() => validateLlmConfig({ presets: { default: "balanced" } })).toThrow(
      LlmConfigValidationError
    );
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

  it("rejects a whitespace-only model id", () => {
    const bad = {
      tiers: {
        ...validConfig.tiers,
        quick: { providers: [{ provider: "anthropic", model: "   " }] },
      },
    };
    expect(() => validateLlmConfig(bad)).toThrow(LlmConfigValidationError);
  });

  it("names the Model ID field and the offending entry when it is blank", () => {
    const blank = {
      tiers: {
        ...validConfig.tiers,
        quick: {
          providers: [
            { provider: "anthropic", model: "claude-haiku-4-5" },
            { provider: "openai", model: "" },
          ],
        },
      },
    };
    expect(() => validateLlmConfig(blank)).toThrow(
      "/tiers/quick/providers/1/model: Model ID is required and must not be blank"
    );
  });

  it("rejects an entry with no provider, which cannot resolve at runtime", () => {
    const bad = {
      tiers: {
        ...validConfig.tiers,
        quick: { providers: [{ provider: "", model: "gpt-4o" }] },
      },
    };
    expect(() => validateLlmConfig(bad)).toThrow(
      "/tiers/quick/providers/0/provider: Provider is required and must not be blank"
    );
  });

  it("rejects a whitespace-only provider", () => {
    const bad = {
      tiers: {
        ...validConfig.tiers,
        quick: { providers: [{ provider: "  ", model: "gpt-4o" }] },
      },
    };
    expect(() => validateLlmConfig(bad)).toThrow(LlmConfigValidationError);
  });

  it("rejects an embedding entry with no provider", () => {
    const bad = {
      ...validConfig,
      embeddings: { providers: [{ provider: "", model: "text-embedding-3-small" }] },
    };
    expect(() => validateLlmConfig(bad)).toThrow(LlmConfigValidationError);
  });
});

describe("dropUnusableProviderEntries", () => {
  it("leaves a config with no blank entries untouched", () => {
    const { config, dropped } = dropUnusableProviderEntries(validConfig);
    expect(config).toBe(validConfig);
    expect(dropped).toEqual([]);
  });

  it("drops a persisted fallback entry that names no model and keeps the rest of the chain", () => {
    const persisted = {
      tiers: {
        ...validConfig.tiers,
        quick: {
          providers: [
            { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "key" },
            { provider: "anthropic", model: "" },
          ],
        },
      },
    };
    const { config, dropped } = dropUnusableProviderEntries(persisted);

    expect(dropped).toEqual([{ tier: "quick", index: 1, provider: "anthropic", model: "" }]);
    expect(persisted.tiers.quick.providers).toHaveLength(2);
    const result = validateLlmConfig(config);
    expect(result.tiers?.quick.providers).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "key" },
    ]);
  });

  it("drops an entry that names no provider", () => {
    const persisted = {
      tiers: {
        ...validConfig.tiers,
        quick: {
          providers: [
            { provider: "anthropic", model: "claude-haiku-4-5" },
            { provider: "   ", model: "gpt-4o" },
          ],
        },
      },
    };
    const { dropped } = dropUnusableProviderEntries(persisted);
    expect(dropped).toEqual([{ tier: "quick", index: 1, provider: "   ", model: "gpt-4o" }]);
  });

  it("passes non-object and chain-less input straight through", () => {
    expect(dropUnusableProviderEntries(null).config).toBeNull();
    expect(dropUnusableProviderEntries({ presets: { default: "balanced" } }).dropped).toEqual([]);
  });
});
