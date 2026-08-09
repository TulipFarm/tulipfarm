/**
 * Turns memory text into vectors for the recall index's dense arm.
 *
 * One interface for both sides of the arm — indexing a statement and embedding a query — because
 * they must use the same model to be comparable at all. Splitting them would make it possible to
 * configure two, and cosine distance between vectors from different models is meaningless.
 *
 * Structurally satisfied by `@tulipfarm/llm`'s `EmbeddingService`, so no adapter is needed; it is
 * declared here rather than imported so `packages/memory` stays free of an LLM dependency.
 */
export interface MemoryEmbedder {
  isAvailable(): boolean;
  embedMany(values: string[]): Promise<{ embeddings: number[][]; dimension: number }>;
  getActive(): { provider: string; model: string; dimension: number | null } | null;
}

/** Embeds one value, or `undefined` when the provider returned nothing usable. */
export async function embedOne(
  embedder: MemoryEmbedder,
  value: string
): Promise<{ embedding: number[]; dimension: number } | undefined> {
  const { embeddings, dimension } = await embedder.embedMany([value]);
  const embedding = embeddings[0];
  return embedding === undefined ? undefined : { embedding, dimension };
}

/**
 * The text an assertion is indexed and matched by. Subject and statement are joined because
 * either alone loses meaning: "Q3" without "acme renewal", or the reverse.
 */
export function embeddableText(subject: string, statement: string): string {
  return `${subject}: ${statement}`;
}
