import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "@tulipfarm/validation";

export class LlmConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigValidationError";
  }
}

export class LlmCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmCredentialError";
  }
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("LLM not configured");
    this.name = "LlmNotConfiguredError";
  }
}

export class UnknownModelError extends Error {
  constructor(modelId: string) {
    super(`model not configured in any tier: ${modelId}`);
    this.name = "UnknownModelError";
  }
}

export class EmbeddingUnavailableError extends Error {
  constructor() {
    super("no embedding provider available");
    this.name = "EmbeddingUnavailableError";
  }
}

/** Warning surfaced to search callers when no embedding provider is available. */
export const EMBEDDING_UNAVAILABLE_WARNING = "embedding-unavailable";

// Curated model spec, resolved from LiteLLM's model_prices_and_context_window.json at config time and
// pinned into the soul (deterministic + git-audited). Field names follow LiteLLM's where they map, so
// the shape is a recognizable standard. Costs are USD per token (LiteLLM's unit). `additionalProperties`
// stays open so future LiteLLM fields don't fail validation.
const ModelSpecSchema = Type.Object(
  {
    litellm_key: Type.Optional(Type.String()),
    input_cost_per_token: Type.Optional(Type.Number({ minimum: 0 })),
    output_cost_per_token: Type.Optional(Type.Number({ minimum: 0 })),
    cache_read_input_token_cost: Type.Optional(Type.Number({ minimum: 0 })),
    cache_creation_input_token_cost: Type.Optional(Type.Number({ minimum: 0 })),
    max_input_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    max_output_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    mode: Type.Optional(Type.String()),
    supports_function_calling: Type.Optional(Type.Boolean()),
    supports_vision: Type.Optional(Type.Boolean()),
    supports_prompt_caching: Type.Optional(Type.Boolean()),
    supports_reasoning: Type.Optional(Type.Boolean()),
    deprecation_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    /** ISO date the spec was resolved/refreshed from LiteLLM. */
    fetched_at: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);

const ProviderEntrySchema = Type.Object({
  provider: Type.String(),
  model: Type.String({ minLength: 1, pattern: "^\\S+$" }),
  api_key_ref: Type.Optional(Type.String()),
  base_url: Type.Optional(Type.String()),
  resource_name: Type.Optional(Type.String()),
  spec: Type.Optional(ModelSpecSchema),
});

const TierConfigSchema = Type.Object({
  providers: Type.Array(ProviderEntrySchema, { minItems: 1 }),
});

const EmbeddingProviderEntrySchema = Type.Object({
  provider: Type.String(),
  model: Type.String({ minLength: 1, pattern: "^\\S+$" }),
  api_key_ref: Type.Optional(Type.String()),
  base_url: Type.Optional(Type.String()),
  resource_name: Type.Optional(Type.String()),
  dimension: Type.Optional(Type.Integer({ minimum: 1 })),
});

const EmbeddingsConfigSchema = Type.Object({
  providers: Type.Array(EmbeddingProviderEntrySchema, { minItems: 1 }),
});

export const LlmConfigSchema = Type.Object({
  tiers: Type.Object({
    quick: TierConfigSchema,
    standard: TierConfigSchema,
    complex: TierConfigSchema,
  }),
  embeddings: Type.Optional(EmbeddingsConfigSchema),
});

export type ModelSpec = Static<typeof ModelSpecSchema>;
export type ProviderEntry = Static<typeof ProviderEntrySchema>;
export type TierConfig = Static<typeof TierConfigSchema>;
export type EmbeddingProviderEntry = Static<typeof EmbeddingProviderEntrySchema>;
export type EmbeddingsConfig = Static<typeof EmbeddingsConfigSchema>;
export type LlmConfig = Static<typeof LlmConfigSchema>;

const checkConfig = ajv.compile(LlmConfigSchema);

export function validateLlmConfig(data: unknown): LlmConfig {
  if (!checkConfig(data)) {
    const e = checkConfig.errors?.[0] ?? { instancePath: "", message: "invalid config" };
    const path = e.instancePath ? `${e.instancePath}: ` : "";
    throw new LlmConfigValidationError(`${path}${e.message ?? "invalid config"}`);
  }
  return data as LlmConfig;
}
