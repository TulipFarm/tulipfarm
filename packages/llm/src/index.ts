export { CODEX_AUTH_SECRET_KEY, CodexAuthError, parseCodexAuth } from "./cli/codex-auth";
export { cliModelIds, cliModelSpec, isSubscriptionProvider } from "./cli/specs";
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
  type ModelSpec,
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
