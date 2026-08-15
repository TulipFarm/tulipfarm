// Ranking + typo-tolerance configuration for the page-level human search spine (retrieval-service.ts).
// Constants are kept here so they are tunable in one place and overridable per-instance in tests.

export interface RankingConfig {
  /** Weight on the title `ts_rank` (title must dominate so an exact title beats a body-only mention). */
  wTitle: number;
  /** Weight on the best chunk's body `ts_rank`. */
  wBody: number;
  /** Recency decay half-life in seconds — `exp(-Δt·ln2/τ)`; recent edits surface, ties break by recency. */
  recencyHalflifeSeconds: number;
  /** When true, run a pg_trgm recall pass if the primary query returns < `trgmThreshold` hits. */
  trgmFallback: boolean;
  /** Primary-hit count below which the trgm recall pass fires. */
  trgmThreshold: number;
}

/** `KNOWLEDGE_TRGM_FALLBACK` is opt-out: anything but "0"/"false" leaves the typo-tolerance pass on. */
function trgmFallbackFromEnv(): boolean {
  const v = process.env.KNOWLEDGE_TRGM_FALLBACK?.trim().toLowerCase();
  return v !== "0" && v !== "false";
}

export const DEFAULT_RANKING: RankingConfig = {
  wTitle: 0.7,
  wBody: 0.3,
  recencyHalflifeSeconds: 90 * 24 * 60 * 60,
  trgmFallback: trgmFallbackFromEnv(),
  trgmThreshold: 5,
};
