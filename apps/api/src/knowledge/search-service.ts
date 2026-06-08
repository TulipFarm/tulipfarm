import { EMBEDDING_UNAVAILABLE_WARNING, EmbeddingUnavailableError } from "@tulipfarm/llm";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import type { EmbeddingPort, SearchFilters, SearchResults } from "./types";

export interface SearchDeps {
  embeddings: EmbeddingPort;
  chunksRepo: KnowledgeChunkRepo;
}

/**
 * Vector-primary search with a lexical fallback (KN-V1-002 / AC-V1-003). When an
 * embedding provider is available the query is embedded and ranked by cosine
 * exact-scan; otherwise (or if the provider fails) it falls back to Postgres
 * full-text and surfaces `warnings: ['embedding-unavailable']`.
 */
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
      // The provider answered: vector search, or a no-warning lexical search if it
      // unexpectedly returned no vector. The warning is reserved for "no provider".
      const results = vec
        ? await chunksRepo.searchVector(vec, out.dimension, limit, filters)
        : await chunksRepo.searchLexical(query, limit, filters);
      return { results, warnings: [] };
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
    }
  }
  const results = await chunksRepo.searchLexical(query, limit, filters);
  return { results, warnings: [EMBEDDING_UNAVAILABLE_WARNING] };
}
