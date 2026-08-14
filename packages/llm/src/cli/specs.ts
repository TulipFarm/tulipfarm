import type { ModelSpec } from "@tulipfarm/schema";

/**
 * CLI providers never resolve against the LiteLLM catalog (`packages/llm/src/model-spec.ts`) —
 * there is no API pricing to fetch for a subscription turn. `validateRoutingCapacity`
 * (`apps/api/src/soul/llm-config/routes.ts`) still hard-rejects any provider entry lacking a
 * verified `max_input_tokens`, so this table is the static fallback `enrichSpecs` reaches for
 * instead of the catalog. Costs are deliberately omitted — a subscription turn has no per-token
 * price, and pinning the API-equivalent number would corrupt cost budgets and
 * `llm_cost_usd_total`. `mode` is fixed to `"chat"` since every model reachable through a CLI
 * provider is a chat model.
 */
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
  /**
   * Codex model slugs as published by `@openai/codex` 0.147.0. The three GPT-5.6 tiers map onto the
   * same shape as the Claude aliases above — `sol` is the flagship, `terra` the balanced tier,
   * `luna` the low-latency one — so an operator picking "the big one" or "the fast one" gets a
   * comparable choice on either subscription.
   */
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

/** Known model ids for a CLI provider, to populate the Settings model picker (no LiteLLM catalog entry exists). */
export function cliModelIds(provider: string): string[] {
  const models = CLI_MODEL_SPECS[provider];
  return models ? Object.keys(models) : [];
}

/**
 * Whether a provider id is a Subscription Provider — i.e. billed by a personal plan, not per token.
 *
 * Cost must be suppressed for these, and suppression cannot be left to "the model id happens to
 * miss the price map": `priceFor` falls back to a longest-family-prefix match, so an operator who
 * types `claude-sonnet-4-6` instead of the `sonnet` alias would have the full Anthropic API price
 * billed into the cost budget and `llm_cost_usd_total` for a turn that cost nothing per token.
 * Derived from the spec table so a provider added there is unpriced by construction.
 */
export function isSubscriptionProvider(provider: string): boolean {
  return provider in CLI_MODEL_SPECS;
}
