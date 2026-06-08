import { EmbeddingUnavailableError } from "@tulipfarm/llm";
import { chunkText } from "./chunk";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import type { KnowledgeDocumentRepo } from "./repo";
import type { ChunkInput, EmbeddingPort, KnowledgeDocument } from "./types";

export interface IndexResult {
  chunkCount: number;
  embedded: boolean;
}

/**
 * (Re)index one document: chunk its plain text, embed the chunks if a provider is
 * available (else store them lexical-only with NULL embeddings), and replace the
 * document's chunks atomically (delete-then-insert — idempotent for retries/updates).
 */
export async function indexDocument(
  doc: KnowledgeDocument,
  chunksRepo: KnowledgeChunkRepo,
  embeddings: EmbeddingPort
): Promise<IndexResult> {
  const textChunks = chunkText(doc.plainText);
  await chunksRepo.deleteByDocument(doc._id);
  if (textChunks.length === 0) return { chunkCount: 0, embedded: false };

  let vectors: (number[] | null)[] = textChunks.map(() => null);
  let model: string | null = null;
  let dim: number | null = null;
  let embedded = false;

  if (embeddings.isAvailable()) {
    try {
      // Snapshot the active model before embedding so a concurrent reload can't swap it under us.
      const active = embeddings.getActive();
      const out = await embeddings.embedMany(textChunks.map((c) => c.content));
      vectors = out.embeddings;
      model = active?.model ?? null;
      dim = out.dimension;
      embedded = true;
    } catch (err) {
      // Provider vanished between isAvailable() and embedMany() → fall back to lexical-only.
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
    }
  }

  const inputs: ChunkInput[] = textChunks.map((c, i) => ({
    chunkIndex: c.index,
    content: c.content,
    embedding: embedded ? (vectors[i] ?? null) : null,
    model: embedded ? model : null,
    dim: embedded ? dim : null,
  }));
  await chunksRepo.insertMany(doc._id, inputs);
  return { chunkCount: inputs.length, embedded };
}

/** Full re-index of every active document (used after a dimension-change guard fires). */
export async function reindexAll(
  docRepo: KnowledgeDocumentRepo,
  chunksRepo: KnowledgeChunkRepo,
  embeddings: EmbeddingPort
): Promise<number> {
  const docs = await docRepo.listActive();
  for (const doc of docs) {
    await indexDocument(doc, chunksRepo, embeddings);
  }
  return docs.length;
}
