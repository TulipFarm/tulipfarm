/**
 * Recall ranking fuses authorized vector/lexical/entity rankings by RRF, then attenuates by
 * recency and importance; unauthorized assertions must not affect order or top-k pressure.
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
   * Recency should break ties in slow-moving memory, not override relevance.
   */
  readonly halfLifeDays?: number;
  /** How much importance may swing the fused score, as a fraction. 0 disables it. */
  readonly importanceWeight?: number;
}

export interface RankedMemoryAssertion {
  readonly assertion: MemoryAssertion;
  readonly score: number;
}

/** RRF offset 60 matches KnowledgeService and lets cross-arm agreement beat one arm's top hit. */
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

/** Drops candidates with no fused score rather than padding relevance results. */
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
