import {
  type EmbeddingCallUsage,
  type EmbeddingUsageSink,
  type ModelPrice,
  priceCall,
} from "@tulipfarm/llm";
import type { ObservabilityService } from "./service";

/** Marks embedding rows inside the shared `llm_call` stream, so they can be told apart in a view. */
export const EMBEDDING_TIER = "embedding";

/**
 * Records every embedding call as an `llm_call` row.
 *
 * Embeddings are a metered model call like any other, and leaving them out of the one table that
 * answers "what did this instance spend" makes every cost view and the spend alert quietly wrong
 * by however much the corpus cost to index.
 *
 * Pricing happens here rather than inside `EmbeddingService` because the operator's overrides live
 * on this side; a second pricing site inside the service is exactly how overrides came to reach
 * only one of two callers before.
 *
 * @param overrides read lazily — observability config is parsed after the embedder is built, and
 * is re-parsed on every Soul sync.
 */
export function createEmbeddingUsageSink(
  obs: ObservabilityService,
  overrides: () => Record<string, ModelPrice> | undefined
): EmbeddingUsageSink {
  return {
    record(usage: EmbeddingCallUsage): void {
      const cost = priceCall({
        provider: usage.provider,
        modelId: usage.model,
        tokensIn: usage.tokens,
        tokensOut: 0,
        spec: usage.spec,
        overrides: overrides(),
      });
      void obs.record({
        type: "llm_call",
        provider: usage.provider,
        model: usage.model,
        tier: EMBEDDING_TIER,
        tokensIn: usage.tokens,
        tokensOut: 0,
        costUsd: cost.kind === "priced" ? cost.costUsd : null,
        durationMs: usage.durationMs,
        status: "ok",
        attributes: { kind: "embedding", values: usage.values, costBasis: cost.kind },
      });
    },
  };
}
