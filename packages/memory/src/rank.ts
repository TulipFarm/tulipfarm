/**
 * Recall ranking (SPEC §14.2, M2).
 *
 * Two stages, deliberately separated:
 *
 * 1. **Fusion.** Each retrieval arm — vector, lexical, entity — contributes a *ranking*, and the
 *    arms are fused by Reciprocal Rank Fusion rather than by score. Arm scores are on
 *    incomparable scales (cosine distance vs. `ts_rank` vs. an overlap count), so fusing on score
 *    would let whichever arm happens to produce larger numbers dominate. RRF only reads position,
 *    and cross-arm agreement is what lifts a result. This matches `KnowledgeService`'s page
 *    retrieval, deliberately: two retrieval paths that rank differently would be two behaviours to
 *    reason about.
 *
 * 2. **Reranking.** Fusion answers "what matches"; it says nothing about whether a match still
 *    matters. Recency decay and importance are applied on top, multiplicatively, so a stale or
 *    trivial assertion is attenuated rather than reordered outright — a strong topical match
 *    stays ahead of a weak-but-fresh one.
 *
 * Everything here is pure. Authorization is not a ranking concern and must not become one: the
 * caller authorizes candidates and only then truncates, so a withheld assertion cannot influence
 * the order of what is returned, nor occupy one of the top-k slots.
 */

import type { MemoryAssertion } from "./memory";

/** Ranks are 0-based positions within one arm's result list; absent means the arm did not hit. */
export interface MemoryCandidateSignals {
  readonly assertionId: string;
  readonly vectorRank?: number;
  readonly lexicalRank?: number;
  readonly entityRank?: number;
}

export interface MemoryRankingOptions {
  readonly now: Date;
  /**
   * Days after which recency weight halves. Memory is mostly slow-moving (a timezone, a
   * preferred name), so the default is deliberately long — recency should break ties, not
   * override relevance.
   */
  readonly halfLifeDays?: number;
  /** How much importance may swing the fused score, as a fraction. 0 disables it. */
  readonly importanceWeight?: number;
}

export interface RankedMemoryAssertion {
  readonly assertion: MemoryAssertion;
  readonly score: number;
}

/**
 * RRF's rank offset. 60 is the value from the original RRF paper and the one
 * `KnowledgeService.hybridSearchPages` uses; it flattens the head of each arm enough that the top
 * result of a single arm cannot outweigh agreement between two.
 */
export const RRF_K = 60;

export const DEFAULT_HALF_LIFE_DAYS = 180;
export const DEFAULT_IMPORTANCE_WEIGHT = 0.5;

const MS_PER_DAY = 86_400_000;

/** Fuse per-arm rankings into one score per assertion. Higher is better. */
export function fuseMemoryCandidates(
  signals: readonly MemoryCandidateSignals[],
  k: number = RRF_K
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const signal of signals) {
    const ranks = [signal.vectorRank, signal.lexicalRank, signal.entityRank];
    let score = 0;
    for (const rank of ranks) {
      if (rank === undefined) continue;
      score += 1 / (k + rank);
    }
    // An arm-less candidate carries no evidence of relevance; recording 0 would let recency and
    // importance alone promote something nothing matched.
    if (score > 0) fused.set(signal.assertionId, (fused.get(signal.assertionId) ?? 0) + score);
  }
  return fused;
}

/**
 * Exponential decay on time since the assertion was last written, halving every `halfLifeDays`.
 * Returns a multiplier in (0, 1].
 */
export function recencyWeight(assertion: MemoryAssertion, now: Date, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageMs = now.getTime() - Date.parse(assertion.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return 2 ** (-ageMs / MS_PER_DAY / halfLifeDays);
}

/**
 * Importance as a multiplier centred on 1, so an average-importance assertion is unchanged and
 * the weight controls how far either extreme may move it.
 */
export function importanceWeight(assertion: MemoryAssertion, weight: number): number {
  const importance = Number.isFinite(assertion.importance) ? assertion.importance : 0.5;
  const clamped = Math.min(1, Math.max(0, importance));
  return 1 + weight * (clamped - 0.5);
}

/**
 * Rerank already-authorized candidates by fused relevance, attenuated by recency and importance.
 *
 * Assertions with no fused score are dropped rather than ranked last: they matched no arm, and
 * padding a relevance-ranked list with irrelevant entries is worse than returning fewer.
 */
export function rankMemoryCandidates(
  assertions: readonly MemoryAssertion[],
  fused: ReadonlyMap<string, number>,
  options: MemoryRankingOptions
): RankedMemoryAssertion[] {
  const halfLife = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const weight = options.importanceWeight ?? DEFAULT_IMPORTANCE_WEIGHT;

  const ranked: RankedMemoryAssertion[] = [];
  for (const assertion of assertions) {
    const base = fused.get(assertion.assertionId);
    if (base === undefined) continue;
    ranked.push({
      assertion,
      score:
        base *
        recencyWeight(assertion, options.now, halfLife) *
        importanceWeight(assertion, weight),
    });
  }

  // Ties break on id, so a given set of candidates always ranks identically — a recall that
  // reordered between identical calls would make prompt caching and golden tests meaningless.
  ranked.sort(
    (a, b) => b.score - a.score || a.assertion.assertionId.localeCompare(b.assertion.assertionId)
  );
  return ranked;
}
