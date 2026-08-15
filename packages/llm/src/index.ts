export { CODEX_AUTH_SECRET_KEY, CodexAuthError, parseCodexAuth } from "./cli/codex-auth";
export { cliModelIds, cliModelSpec, isSubscriptionProvider } from "./cli/specs";
export { createEmbeddingModel } from "./embedding-provider";
export {
  EMBEDDING_DEMOTE_MS,
  EMBEDDING_REINDEX_PENDING_WARNING,
  EMBEDDING_TIMEOUT_MS,
  EMBEDDING_UNAVAILABLE_WARNING,
  type EmbeddingCallUsage,
  type EmbeddingLogger,
  EmbeddingService,
  type EmbeddingServiceOptions,
  type EmbeddingUsageSink,
} from "./embeddings";
export {
  type FallbackLogger,
  FallbackModel,
  isHardFailure,
  type ModelResponderRef,
} from "./fallback";
export type { LlmLogger, ResolvedModelEntry } from "./llm-service";
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
export {
  type CostBasis,
  isPriceable,
  type ModelPrice,
  PRICING,
  type PriceCallInput,
  type PriceSource,
  priceCall,
} from "./pricing";
export { SecretsPrincipalCredentials } from "./principal-credentials";
export {
  createModel,
  type PrincipalCredentialResolver,
  type PrincipalRef,
} from "./provider";
export {
  ClassifiedLanguageModel,
  classifyProviderError,
  LlmProviderError,
  type LlmProviderFailureReason,
} from "./provider-error";
