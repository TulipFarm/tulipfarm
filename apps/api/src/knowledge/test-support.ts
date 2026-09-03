import type { EmbeddingPort } from "@tulipfarm/knowledge";

/**
 * An `EmbeddingPort` that reports itself unavailable, for tests that exercise knowledge paths
 * without a model. `embedMany` still returns fixed 3-dimensional vectors so callers that embed
 * regardless of `isAvailable` stay on a deterministic shape.
 */
export function noEmbeddings(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}
