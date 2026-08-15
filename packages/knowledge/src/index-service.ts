import { createHash } from "node:crypto";
import { EmbeddingUnavailableError } from "@tulipfarm/schema";
import { chunkText } from "./chunk";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import type { KnowledgePageRepo } from "./repo";
import type { ChunkInput, EmbeddingPort, KnowledgePage } from "./types";

export interface IndexResult {
  chunkCount: number;
  embedded: boolean;
}

function contentHash(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * (Re)index one page: chunk its plain text, then embed only the chunks whose content actually
 * changed since the last index. A chunk reuses its stored embedding when, at the same `chunkIndex`,
 * the prior chunk's `content_hash` matches AND it was embedded under the currently-active model —
 * so a one-line edit to a large page re-embeds one chunk instead of all of them. Chunks with no
 * available provider (or a provider that vanished mid-flight) store lexical-only with NULL
 * embeddings.
 */
export async function indexPage(
  page: KnowledgePage,
  chunksRepo: KnowledgeChunkRepo,
  embeddings: EmbeddingPort
): Promise<IndexResult> {
  const textChunks = chunkText(page.plainText);
  if (textChunks.length === 0) {
    await chunksRepo.replaceForPage(page._id, []);
    return { chunkCount: 0, embedded: false };
  }

  const available = embeddings.isAvailable();
  // Snapshot the active model before embedding so a concurrent reload can't swap it under us.
  const active = available ? embeddings.getActive() : null;
  const activeModel = active?.model ?? null;
  const hashes = textChunks.map((c) => contentHash(c.content));

  const existing = await chunksRepo.listByPageForDiff(page._id);
  const priorByIndex = new Map(existing.map((c) => [c.chunkIndex, c]));
  const vectors: (number[] | null)[] = textChunks.map(() => null);
  const dims: (number | null)[] = textChunks.map(() => null);
  textChunks.forEach((c, i) => {
    const prior = priorByIndex.get(c.index);
    if (
      activeModel !== null &&
      prior &&
      prior.embedding !== null &&
      prior.contentHash === hashes[i] &&
      prior.model === activeModel
    ) {
      vectors[i] = prior.embedding;
      dims[i] = prior.dim;
    }
  });

  const toEmbed = textChunks
    .map((c, i) => ({ content: c.content, i }))
    .filter(({ i }) => vectors[i] === null);
  if (available && toEmbed.length > 0) {
    try {
      const out = await embeddings.embedMany(toEmbed.map((t) => t.content));
      out.embeddings.forEach((vec, j) => {
        vectors[toEmbed[j].i] = vec;
        dims[toEmbed[j].i] = out.dimension;
      });
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
    }
  }

  const inputs: ChunkInput[] = textChunks.map((c, i) => ({
    chunkIndex: c.index,
    content: c.content,
    contentHash: hashes[i],
    embedding: vectors[i],
    model: vectors[i] !== null ? activeModel : null,
    dim: vectors[i] !== null ? dims[i] : null,
  }));
  await chunksRepo.replaceForPage(page._id, inputs);
  return { chunkCount: inputs.length, embedded: vectors.some((v) => v !== null) };
}

export async function reindexAll(
  pageRepo: KnowledgePageRepo,
  chunksRepo: KnowledgeChunkRepo,
  embeddings: EmbeddingPort
): Promise<number> {
  const pages = await pageRepo.listActive();
  for (const page of pages) {
    await indexPage(page, chunksRepo, embeddings);
  }
  return pages.length;
}
