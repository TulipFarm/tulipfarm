// Ranking + typo-tolerance configuration for the page-level human search spine (retrieval-service.ts).
// Constants are kept here so they are tunable in one place and overridable per-instance in tests.

import type { KnowledgePrincipalRef } from "./source";
import { BLANKET_READ_PRINCIPAL } from "./subject";

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

/** Governs how much of the unified Knowledge access model is live in `retrieve()`. */
export interface KnowledgeAccessConfig {
  /**
   * Whether authored Pages are authorized and returned by `retrieve()`. The ACL model itself is
   * never optional — a correctness fix cannot have an "off" that means unguarded — but unifying the
   * retrieval path is, so cutover stays reversible.
   */
  authoredPagesInRetrieval: boolean;
  /** Entries evaluated per subject before the gate denies, bounding a pathological ACL. */
  maxAclEntriesPerSubject: number;
}

/** `KNOWLEDGE_AUTHORED_PAGES_IN_RETRIEVAL` is opt-in: only "1"/"true" turns the unified path on. */
function authoredPagesFromEnv(): boolean {
  const v = process.env.KNOWLEDGE_AUTHORED_PAGES_IN_RETRIEVAL?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export const DEFAULT_MAX_ACL_ENTRIES_PER_SUBJECT = 1000;

export const DEFAULT_KNOWLEDGE_ACCESS: KnowledgeAccessConfig = {
  authoredPagesInRetrieval: authoredPagesFromEnv(),
  maxAclEntriesPerSubject: DEFAULT_MAX_ACL_ENTRIES_PER_SUBJECT,
};

/**
 * Ceiling on how far `graph-expand` may walk. Two hops is not a tuning preference: the neighbourhood
 * grows with the branching factor at each hop, and every page reached costs an authorization.
 */
export const MAX_GRAPH_EXPAND_DEPTH = 2;

/** Bounded graph walk over `knowledge_links`, sitting between retrieval and reranking. */
export interface GraphExpandConfig {
  enabled: boolean;
  /** Hops out from the seed pages. Clamped to `MAX_GRAPH_EXPAND_DEPTH`. */
  depth: number;
  /** Ceiling on neighbour pages across all hops combined. */
  maxNeighbours: number;
  /**
   * Per-hop multiplier. Must stay strictly below `bandFloor`: that inequality is the whole proof
   * that a deeper hop cannot outrank a shallower one, since it makes the score bands disjoint.
   */
  hopDecay: number;
  /** Lowest fraction of its band a hop may occupy, so each hop lands in `[decay^h * floor, decay^h]`. */
  bandFloor: number;
}

/** `KNOWLEDGE_GRAPH_EXPAND` is opt-in: only "1"/"true" turns the walk on. */
function graphExpandFromEnv(): boolean {
  const v = process.env.KNOWLEDGE_GRAPH_EXPAND?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export const DEFAULT_GRAPH_EXPAND: GraphExpandConfig = {
  enabled: graphExpandFromEnv(),
  depth: 1,
  maxNeighbours: 50,
  hopDecay: 0.25,
  bandFloor: 0.5,
};

/**
 * GraphRAG: the LLM-built entity graph, its communities and their summaries. Separate from
 * `GraphExpandConfig` and not a variant of it — that walks edges a human already drew, this one
 * infers a graph and pays a model per chunk to do it. Off by default because it is expensive.
 */
export interface GraphRagConfig {
  enabled: boolean;
  /** Levels of community hierarchy to detect and summarise. */
  maxCommunityLevels: number;
  /** Chunks one extraction run may spend a model on, so a build cannot run away with the budget. */
  maxChunksPerRun: number;
  /** Community summaries a global search may reduce over. */
  maxSummariesPerQuery: number;
  /**
   * Principals that stand for "everyone in the business". A community summary may only be built
   * over chunks explicitly granted to one of these, because derived text cannot be un-blended
   * afterwards. Empty means nothing is broadly readable, which denies rather than permits.
   */
  blanketPrincipals: readonly KnowledgePrincipalRef[];
}

/** `KNOWLEDGE_GRAPHRAG` is opt-in: only "1"/"true" turns the subsystem on. */
function graphRagFromEnv(): boolean {
  const v = process.env.KNOWLEDGE_GRAPHRAG?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export const DEFAULT_BLANKET_PRINCIPALS: readonly KnowledgePrincipalRef[] = [
  BLANKET_READ_PRINCIPAL,
];

export const DEFAULT_GRAPHRAG: GraphRagConfig = {
  enabled: graphRagFromEnv(),
  maxCommunityLevels: 3,
  maxChunksPerRun: 500,
  maxSummariesPerQuery: 30,
  blanketPrincipals: DEFAULT_BLANKET_PRINCIPALS,
};
