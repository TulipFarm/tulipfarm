import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { MODEL_DATA_RETENTION, type ModelDataRetention } from "./definitions/common";

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

// Curated LiteLLM spec pinned into Soul; costs are USD/token and future fields stay allowed.
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

/** Both halves of a chain entry's address. Blank or padded, the entry can never serve a call. */
const ChainIdentifierSchema = Type.String({ minLength: 1, pattern: "^\\S+$" });

const ProviderEntrySchema = Type.Object({
  provider: ChainIdentifierSchema,
  model: ChainIdentifierSchema,
  api_key_ref: Type.Optional(Type.String()),
  base_url: Type.Optional(Type.String()),
  resource_name: Type.Optional(Type.String()),
  spec: Type.Optional(ModelSpecSchema),
  /**
   * What this entry's governance posture *is*, so a turn that requires one can be matched
   * against it. Undeclared stays undeclared: `selectModelProfile` treats an absent posture as
   * unverifiable rather than permissive, so declaring nothing denies a turn that demands one.
   */
  constraints: Type.Optional(
    Type.Object(
      {
        data_retention: Type.Optional(
          Type.Unsafe<ModelDataRetention>({ type: "string", enum: [...MODEL_DATA_RETENTION] })
        ),
        allow_training: Type.Optional(Type.Boolean()),
        residency: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        max_latency_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false }
    )
  ),
  /**
   * Per-Run execution ceilings for calls this entry serves.
   *
   * `ModelProfileSpec.budgets` has always been consumed by the Run budget resolver, but nothing
   * derived it from authored config, so no operator could declare a ceiling here at all. Without
   * this the enforcement path is reachable only from tests.
   */
  budgets: Type.Optional(
    Type.Object(
      {
        max_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
        max_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false }
    )
  ),
});

const TierConfigSchema = Type.Object({
  providers: Type.Array(ProviderEntrySchema, { minItems: 1 }),
});

/** Named provider credentials; name keys preserve multi-account setups. */
const ProviderConnectionSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  api_key_ref: Type.Optional(Type.String()),
  base_url: Type.Optional(Type.String()),
  resource_name: Type.Optional(Type.String()),
});

const EmbeddingProviderEntrySchema = Type.Object({
  provider: ChainIdentifierSchema,
  model: ChainIdentifierSchema,
  api_key_ref: Type.Optional(Type.String()),
  base_url: Type.Optional(Type.String()),
  resource_name: Type.Optional(Type.String()),
  dimension: Type.Optional(Type.Integer({ minimum: 1 })),
  /**
   * Per-token costs, same pinned shape a chat entry carries. Embedding models are absent from the
   * fallback price table, so without this an embedding call is unpriceable and its spend is
   * invisible however carefully the rest of the spend spine is wired.
   */
  spec: Type.Optional(ModelSpecSchema),
});

const EmbeddingsConfigSchema = Type.Object({
  providers: Type.Array(EmbeddingProviderEntrySchema, { minItems: 1 }),
});

export const LlmConfigSchema = Type.Object({
  /** Named provider credentials. ModelProfiles reference these; secrets never leave here. */
  connections: Type.Optional(Type.Record(Type.String({ minLength: 1 }), ProviderConnectionSchema)),
  // Sole authored model source; runtime and publication derive ModelProfiles from it.
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

/** The field name an operator sees, for the two identifiers a chain entry cannot go without. */
const CHAIN_IDENTIFIER_LABELS: Readonly<Record<string, string>> = {
  model: "Model ID",
  provider: "Provider",
};

/**
 * AJV reports a blank identifier as `must NOT have fewer than 1 characters`, which names neither
 * the field an operator filled in nor what to do about it. The instancePath is kept so a client
 * can still point the message at the right row.
 */
function describeConfigError(error: {
  keyword?: string;
  instancePath: string;
  message?: string;
}): string {
  const path = error.instancePath ? `${error.instancePath}: ` : "";
  const label = CHAIN_IDENTIFIER_LABELS[error.instancePath.split("/").pop() ?? ""];
  if (label !== undefined && (error.keyword === "minLength" || error.keyword === "pattern")) {
    return `${path}${label} is required and must not be blank`;
  }
  return `${path}${error.message ?? "invalid config"}`;
}

export function validateLlmConfig(data: unknown): LlmConfig {
  if (!checkConfig(data)) {
    const e = checkConfig.errors?.[0] ?? { instancePath: "", message: "invalid config" };
    throw new LlmConfigValidationError(describeConfigError(e));
  }
  const config = data as LlmConfig;
  // Effort Presets name derived profiles; without chains they point at nothing.
  if (config.tiers === undefined) {
    throw new LlmConfigValidationError("config must declare provider chains in tiers");
  }
  return config;
}

/** A chain entry that was dropped because it named no provider or no model. */
export interface UnusableProviderEntry {
  readonly tier: string;
  /** Position in the authored chain, so a warning can name the row an operator sees. */
  readonly index: number;
  readonly provider: string;
  readonly model: string;
}

function isBlankIdentifier(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Remove chain entries that name no provider or no model from an *authored* config.
 *
 * Writes are rejected outright by {@link validateLlmConfig}, but an instance may already hold such
 * an entry from before that constraint existed. Validating it on load would fail the whole
 * `llm:` block, taking every working chain down with the one broken row and leaving no page from
 * which to delete it. Dropping it instead keeps the rest of the chain serving.
 *
 * The input is never mutated; the original object is returned when nothing was dropped.
 */
export function dropUnusableProviderEntries(raw: unknown): {
  config: unknown;
  dropped: UnusableProviderEntry[];
} {
  const dropped: UnusableProviderEntry[] = [];
  if (raw === null || typeof raw !== "object") return { config: raw, dropped };
  const source = raw as Record<string, unknown>;
  const tiers = source.tiers;
  if (tiers === null || typeof tiers !== "object") return { config: raw, dropped };

  const nextTiers: Record<string, unknown> = {};
  for (const [tier, value] of Object.entries(tiers as Record<string, unknown>)) {
    const providers = (value as { providers?: unknown } | null)?.providers;
    if (!Array.isArray(providers)) {
      nextTiers[tier] = value;
      continue;
    }
    const kept = providers.filter((entry, index) => {
      const candidate = entry as { provider?: unknown; model?: unknown } | null;
      if (!isBlankIdentifier(candidate?.provider) && !isBlankIdentifier(candidate?.model)) {
        return true;
      }
      dropped.push({
        tier,
        index,
        provider: typeof candidate?.provider === "string" ? candidate.provider : "",
        model: typeof candidate?.model === "string" ? candidate.model : "",
      });
      return false;
    });
    nextTiers[tier] =
      kept.length === providers.length ? value : { ...(value as object), providers: kept };
  }

  if (dropped.length === 0) return { config: raw, dropped };
  return { config: { ...source, tiers: nextTiers }, dropped };
}
