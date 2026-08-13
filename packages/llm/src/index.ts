export { cliModelIds, cliModelSpec } from "./cli/specs";
export { createEmbeddingModel } from "./embedding-provider";
export {
  EMBEDDING_UNAVAILABLE_WARNING,
  type EmbeddingLogger,
  EmbeddingService,
} from "./embeddings";
export { type FallbackLogger, FallbackModel, isHardFailure } from "./fallback";
export type { ResolvedModelEntry } from "./llm-service";
export { LlmService } from "./llm-service";
export {
  fetchLiteLlmCatalog,
  type LiteLlmCatalog,
  litellmModelsForProvider,
  resolveModelSpec,
  resolveModelSpecCandidate,
  type SpecResolution,
} from "./model-spec";
export { type ModelPrice, PRICING, type PriceResult, priceFor } from "./pricing";
export { createModel } from "./provider";
export {
  ClassifiedLanguageModel,
  classifyProviderError,
  LlmProviderError,
  type LlmProviderFailureReason,
} from "./provider-error";
