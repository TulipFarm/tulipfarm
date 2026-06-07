export {
  EMBEDDING_UNAVAILABLE_WARNING,
  EmbeddingUnavailableError,
  LlmConfigValidationError,
  LlmCredentialError,
  LlmNotConfiguredError,
  UnknownModelError,
  validateLlmConfig,
} from "./config";
export type {
  EmbeddingProviderEntry,
  EmbeddingsConfig,
  LlmConfig,
  ProviderEntry,
  TierConfig,
} from "./config";
export { FallbackModel, type FallbackLogger, isHardFailure } from "./fallback";
export { createModel } from "./provider";
export { createEmbeddingModel } from "./embedding-provider";
export { EmbeddingService, type EmbeddingLogger } from "./embeddings";
export { resolveTier } from "./selection";
export type { Autonomy, ModelSelector, SelectionContext } from "./selection";
export { LlmService } from "./llm-service";
export type { SelectRequest, Tier } from "./llm-service";
