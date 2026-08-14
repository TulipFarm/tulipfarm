// Inert, flag-gated rerank seam for the hybrid `query_knowledge` pipeline. Default is a pure no-op
// (identity) so the off-path is byte-stable; when `KNOWLEDGE_RERANK` is enabled this resolves to an
// honest stub that throws `NotImplementedError` only if actually invoked. No model call, no real
// reranking — this is just the wiring for a future cross-encoder/LLM rerank stage.

import { NotImplementedError } from "./connectors/types";
import type { QueryKnowledgeHit } from "./types";

/** A pluggable reordering stage over page-level hits, applied after hybrid retrieval. */
export interface RerankStage {
  rerank(query: string, pages: QueryKnowledgeHit[], topK: number): Promise<QueryKnowledgeHit[]>;
}

/** Identity rerank stage: returns `pages` unchanged so unset rerank is byte-stable. */
export const noopRerank: RerankStage = {
  rerank(_query: string, pages: QueryKnowledgeHit[], _topK: number): Promise<QueryKnowledgeHit[]> {
    return Promise.resolve(pages);
  },
};

/** Wired rerank seam that throws `NotImplementedError` when enabled. */
export class NotImplementedRerank implements RerankStage {
  rerank(_query: string, _pages: QueryKnowledgeHit[], _topK: number): Promise<QueryKnowledgeHit[]> {
    // NotImplementedError's message is `connector <a>: <b> is not implemented`; we reuse the class
    // verbatim (don't fork the error style) so it reads "...rerank: LLM rerank is not implemented".
    throw new NotImplementedError("rerank", "LLM rerank");
  }
}

/** `KNOWLEDGE_RERANK` opt-in values: "1", "true", or "on". */
export function resolveRerank(env: NodeJS.ProcessEnv = process.env): RerankStage {
  const v = env.KNOWLEDGE_RERANK?.trim().toLowerCase();
  const enabled = v === "1" || v === "true" || v === "on";
  return enabled ? new NotImplementedRerank() : noopRerank;
}
