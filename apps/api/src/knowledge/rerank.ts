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

/**
 * Pure identity: returns `pages` unchanged (no slice, no reorder) so an unset flag is a true
 * byte-stable no-op. The caller already passes the desired, capped list — `topK` is accepted only
 * to match the `RerankStage` shape.
 */
export const noopRerank: RerankStage = {
  rerank(_query: string, pages: QueryKnowledgeHit[], _topK: number): Promise<QueryKnowledgeHit[]> {
    return Promise.resolve(pages);
  },
};

/**
 * Honest stub for the future LLM/cross-encoder rerank. Satisfies `RerankStage` but throws
 * `NotImplementedError` (the same class the connector stubs use) the moment it's invoked, so the
 * seam is wired and enableable today without pretending to rerank.
 */
export class NotImplementedRerank implements RerankStage {
  rerank(_query: string, _pages: QueryKnowledgeHit[], _topK: number): Promise<QueryKnowledgeHit[]> {
    // NotImplementedError's message is `connector <a>: <b> is not implemented`; we reuse the class
    // verbatim (don't fork the error style) so it reads "...rerank: LLM rerank is not implemented".
    throw new NotImplementedError("rerank", "LLM rerank");
  }
}

/** `KNOWLEDGE_RERANK` is opt-in: "1"/"true"/"on" enables the stub stage; anything else stays a no-op. */
export function resolveRerank(env: NodeJS.ProcessEnv = process.env): RerankStage {
  const v = env.KNOWLEDGE_RERANK?.trim().toLowerCase();
  const enabled = v === "1" || v === "true" || v === "on";
  return enabled ? new NotImplementedRerank() : noopRerank;
}
