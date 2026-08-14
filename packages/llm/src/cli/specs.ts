import type { ModelSpec } from "@tulipfarm/schema";

/** Static CLI specs supply context windows only; subscription turns must not get token prices. */
const CLI_MODEL_SPECS: Record<string, Record<string, ModelSpec>> = {
  "claude-code": {
    opus: {
      max_input_tokens: 200_000,
      max_output_tokens: 32_000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_prompt_caching: true,
      supports_reasoning: true,
    },
    sonnet: {
      max_input_tokens: 200_000,
      max_output_tokens: 64_000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_prompt_caching: true,
      supports_reasoning: true,
    },
    haiku: {
      max_input_tokens: 200_000,
      max_output_tokens: 64_000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_prompt_caching: true,
      supports_reasoning: false,
    },
  },
  /** Codex slugs from `@openai/codex` 0.147.0; sol/terra/luna mirror Claude tiers. */
  codex: {
    "gpt-5.6-sol": {
      max_input_tokens: 272_000,
      max_output_tokens: 128_000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_prompt_caching: true,
      supports_reasoning: true,
    },
    "gpt-5.6-terra": {
      max_input_tokens: 272_000,
      max_output_tokens: 128_000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_prompt_caching: true,
      supports_reasoning: true,
    },
    "gpt-5.6-luna": {
      max_input_tokens: 272_000,
      max_output_tokens: 128_000,
      mode: "chat",
      supports_function_calling: true,
      supports_vision: true,
      supports_prompt_caching: true,
      supports_reasoning: false,
    },
  },
};

/** Match a CLI model id against the static table, tolerating an alias like `claude-sonnet-4-6`. */
function lookup(models: Record<string, ModelSpec>, model: string): ModelSpec | undefined {
  if (models[model]) return models[model];
  const lower = model.toLowerCase();
  for (const [key, spec] of Object.entries(models)) {
    if (lower.includes(key)) return spec;
  }
  return undefined;
}

/** Static spec fallback for a CLI provider's model, used where the LiteLLM catalog cannot help. */
export function cliModelSpec(provider: string, model: string): ModelSpec | undefined {
  const models = CLI_MODEL_SPECS[provider];
  return models ? lookup(models, model) : undefined;
}

/** CLI model ids for Settings; no LiteLLM catalog entry exists. */
export function cliModelIds(provider: string): string[] {
  const models = CLI_MODEL_SPECS[provider];
  return models ? Object.keys(models) : [];
}

/** Subscription providers are explicitly unpriced; do not rely on price-map misses. */
export function isSubscriptionProvider(provider: string): boolean {
  return provider in CLI_MODEL_SPECS;
}
