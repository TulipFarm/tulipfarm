import type { LlmConfig } from "@tulipfarm/llm";
import type { LlmProviderInfo } from "@tulipfarm/secrets";
import { describe, expect, it } from "vitest";
import { pruneLlmConfig } from "./prune";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const azure: LlmProviderInfo = {
  id: "azure",
  label: "Azure OpenAI",
  fields: [
    { key: "azure-openai-api-key", label: "API key", role: "api_key", kind: "secret" },
    {
      key: "azure-openai-resource-name",
      label: "Resource name",
      role: "resource_name",
      kind: "config",
    },
  ],
};

const anthropic: LlmProviderInfo = {
  id: "anthropic",
  label: "Anthropic",
  fields: [{ key: "anthropic-api-key", label: "API key", role: "api_key", kind: "secret" }],
};

function makeConfig(overrides: Partial<LlmConfig["tiers"]> = {}): LlmConfig {
  return {
    tiers: {
      quick: { providers: [{ provider: "azure", model: "gpt-4o" }] },
      standard: { providers: [{ provider: "azure", model: "gpt-4o" }] },
      complex: { providers: [{ provider: "azure", model: "gpt-4o" }] },
      ...overrides,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("pruneLlmConfig", () => {
  it("returns 'unchanged' when no entries reference the deleted key", () => {
    const config = makeConfig();
    const result = pruneLlmConfig(config, "anthropic-api-key", anthropic);
    expect(result.action).toBe("unchanged");
  });

  it("returns 'delete' when all tiers have only the affected provider (single-provider setup)", () => {
    const config = makeConfig();
    const result = pruneLlmConfig(config, "azure-openai-api-key", azure);
    expect(result.action).toBe("delete");
  });

  it("returns 'delete' when any one tier would be left empty after pruning", () => {
    const config = makeConfig({
      quick: {
        providers: [
          { provider: "azure", model: "gpt-4o" },
          { provider: "anthropic", model: "claude-haiku-4-5" },
        ],
      },
      standard: {
        providers: [
          { provider: "azure", model: "gpt-4o" },
          { provider: "anthropic", model: "claude-haiku-4-5" },
        ],
      },
      // complex has only azure — will become empty after pruning
      complex: { providers: [{ provider: "azure", model: "gpt-4o" }] },
    });
    const result = pruneLlmConfig(config, "azure-openai-api-key", azure);
    expect(result.action).toBe("delete");
  });

  it("returns 'update' when affected entries removed and every tier still has ≥1 provider", () => {
    const config = makeConfig({
      quick: {
        providers: [
          { provider: "azure", model: "gpt-4o" },
          { provider: "anthropic", model: "claude-haiku-4-5" },
        ],
      },
      standard: {
        providers: [
          { provider: "azure", model: "gpt-4o" },
          { provider: "anthropic", model: "claude-sonnet-4-6" },
        ],
      },
      complex: {
        providers: [
          { provider: "azure", model: "gpt-4o" },
          { provider: "anthropic", model: "claude-opus-4-8" },
        ],
      },
    });
    const result = pruneLlmConfig(config, "azure-openai-api-key", azure);
    expect(result.action).toBe("update");
    if (result.action !== "update") return;

    for (const tier of ["quick", "standard", "complex"] as const) {
      expect(result.config.tiers[tier].providers.every((e) => e.provider !== "azure")).toBe(true);
      expect(result.config.tiers[tier].providers.length).toBeGreaterThan(0);
    }
  });

  it("removes entries with an explicit api_key_ref matching the deleted key", () => {
    const config = makeConfig({
      quick: {
        providers: [
          { provider: "azure", model: "gpt-4o", api_key_ref: "azure-openai-api-key" },
          { provider: "anthropic", model: "claude-haiku-4-5" },
        ],
      },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
    });
    const result = pruneLlmConfig(config, "azure-openai-api-key", azure);
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.config.tiers.quick.providers).toHaveLength(1);
    expect(result.config.tiers.quick.providers[0]?.provider).toBe("anthropic");
  });

  it("does not remove entries using env:// api_key_ref (reads from process.env, not secrets)", () => {
    const config = makeConfig({
      quick: {
        providers: [{ provider: "azure", model: "gpt-4o", api_key_ref: "env://AZURE_API_KEY" }],
      },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
    });
    const result = pruneLlmConfig(config, "azure-openai-api-key", azure);
    expect(result.action).toBe("unchanged");
  });

  it("does not remove entries using a different explicit api_key_ref", () => {
    const config = makeConfig({
      quick: {
        providers: [{ provider: "azure", model: "gpt-4o", api_key_ref: "my-custom-azure-key" }],
      },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
    });
    const result = pruneLlmConfig(config, "azure-openai-api-key", azure);
    expect(result.action).toBe("unchanged");
  });

  it("preserves the embeddings field when returning 'update'", () => {
    const config: LlmConfig = {
      tiers: {
        quick: {
          providers: [
            { provider: "azure", model: "gpt-4o" },
            { provider: "anthropic", model: "claude-haiku-4-5" },
          ],
        },
        standard: {
          providers: [
            { provider: "azure", model: "gpt-4o" },
            { provider: "anthropic", model: "claude-sonnet-4-6" },
          ],
        },
        complex: {
          providers: [
            { provider: "azure", model: "gpt-4o" },
            { provider: "anthropic", model: "claude-opus-4-8" },
          ],
        },
      },
      embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
    };
    const result = pruneLlmConfig(config, "azure-openai-api-key", azure);
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.config.embeddings).toEqual(config.embeddings);
  });
});
