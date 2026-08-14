import { EMBEDDING_UNAVAILABLE_WARNING } from "@tulipfarm/llm";
import { EmbeddingUnavailableError } from "@tulipfarm/schema";
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
      return { results, warnings: [] };
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
    }
  }
  const results = await chunksRepo.searchLexical(query, limit, filters);
  return { results, warnings: [EMBEDDING_UNAVAILABLE_WARNING] };
}
