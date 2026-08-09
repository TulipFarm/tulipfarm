import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";

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

/**
 * A named set of provider credentials, addressed by ModelProfiles via `spec.connection`.
 *
 * Credentials are separated from routing because they answer a different question and have a
 * different audience: a connection is admin/secret-bearing infrastructure, while a ModelProfile is
 * git-audited governance. Keying by name rather than by provider preserves multi-account setups —
 * two Azure resources with different keys are two connections, which per-entry `api_key_ref` in the
 * tier config could express and a provider-keyed map could not.
 */
const ProviderConnectionSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  api_key_ref: Type.Optional(Type.String()),
  base_url: Type.Optional(Type.String()),
  resource_name: Type.Optional(Type.String()),
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
  /** Named provider credentials. ModelProfiles reference these by name; secrets never leave here. */
  connections: Type.Optional(Type.Record(Type.String({ minLength: 1 }), ProviderConnectionSchema)),
  // Authoring shape for the three ordered provider chains. Runtime and publication both derive
  // ModelProfiles from it (see `model-catalog.ts`); no second models/ representation exists.
  tiers: Type.Optional(
    Type.Object({
      quick: TierConfigSchema,
      standard: TierConfigSchema,
      complex: TierConfigSchema,
    })
  ),
  /** Effort preset → ModelProfile ref. The only model concept a participant ever picks. */
  presets: Type.Optional(
    Type.Object({
      default: Type.Optional(Type.String({ minLength: 1 })),
      fast: Type.Optional(Type.String({ minLength: 1 })),
      balanced: Type.Optional(Type.String({ minLength: 1 })),
      thorough: Type.Optional(Type.String({ minLength: 1 })),
    })
  ),
  embeddings: Type.Optional(EmbeddingsConfigSchema),
});

export type ModelSpec = Static<typeof ModelSpecSchema>;
export type ProviderEntry = Static<typeof ProviderEntrySchema>;
export type ProviderConnection = Static<typeof ProviderConnectionSchema>;
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
  const config = data as LlmConfig;
  // Provider chains are the sole authored model source. Effort Presets name the derived profiles;
  // without chains they point at nothing and would fail only when the first turn routes.
  if (config.tiers === undefined) {
    throw new LlmConfigValidationError("config must declare provider chains in tiers");
  }
  return config;
}
