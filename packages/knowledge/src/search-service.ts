import { EMBEDDING_REINDEX_PENDING_WARNING, EMBEDDING_UNAVAILABLE_WARNING } from "@tulipfarm/llm";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import type { EmbeddingPort, SearchFilters, SearchResults } from "./types";

export interface SearchDeps {
  embeddings: EmbeddingPort;
  chunksRepo: KnowledgeChunkRepo;
}

/** KN-V1-002 vector-primary search; fallback to FTS with `embedding-unavailable`. */
export async function search(
  query: string,
  filters: SearchFilters,
  limit: number,
  deps: SearchDeps
): Promise<SearchResults> {
  const { embeddings, chunksRepo } = deps;
  if (embeddings.isAvailable()) {
    try {
      const out = await embeddings.embedMany([query]);
      const vec = out.embeddings[0];
      // Warn only when no provider answered; an empty vector response falls back silently.
      const results = vec
        ? await chunksRepo.searchVector(vec, out.dimension, limit, filters)
        : await chunksRepo.searchLexical(query, limit, filters);
      // A pending re-index means stored vectors are at the *old* width, which `searchVector`
      // matches exactly and therefore never returns. Recall is degraded, not merely stale, so the
      // caller has to be told rather than handed a confident empty result.
      return {
        results,
        warnings: embeddings.pendingReindex() ? [EMBEDDING_REINDEX_PENDING_WARNING] : [],
      };
    } catch {
      // Any embedding failure degrades to lexical. Re-throwing a rate limit or a timeout turned a
      // recall problem into a failed search, which is strictly worse than fewer results plus the
      // warning the caller already knows how to render.
    }
  }
  const results = await chunksRepo.searchLexical(query, limit, filters);
  return { results, warnings: [EMBEDDING_UNAVAILABLE_WARNING] };
}
