export type {
  EmbeddingProviderEntry,
  EmbeddingsConfig,
  LlmConfig,
  ModelSpec,
  ProviderEntry,
  TierConfig,
} from "./config";
export {
  EMBEDDING_UNAVAILABLE_WARNING,
  EmbeddingUnavailableError,
  LlmConfigSchema,
  LlmConfigValidationError,
  LlmCredentialError,
  LlmNotConfiguredError,
  UnknownModelError,
  validateLlmConfig,
} from "./config";
export { createEmbeddingModel } from "./embedding-provider";
export { type EmbeddingLogger, EmbeddingService } from "./embeddings";
export { type FallbackLogger, FallbackModel, isHardFailure } from "./fallback";
export type {
  ResolvedModel,
  ResolvedModelEntry,
  SelectRequest,
  Tier,
} from "./llm-service";
export { LlmService } from "./llm-service";
export {
  fetchLiteLlmCatalog,
  type LiteLlmCatalog,
  litellmModelsForProvider,
  resolveModelSpec,
  type SpecResolution,
} from "./model-spec";
export { type ModelPrice, PRICING, type PriceResult, priceFor } from "./pricing";
export { createModel } from "./provider";
export type { Autonomy, ModelSelector, SelectionContext } from "./selection";
export { resolveTier } from "./selection";
