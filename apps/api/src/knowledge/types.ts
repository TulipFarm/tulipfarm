// Knowledge/vector subsystem data types (P3, spec KN-V1). Internal pages use `_id`
// (mapped to `id` at the API boundary, like the rest of the codebase). Markdown lives
// in `content`; `plainText` is the indexed form.

export type KnowledgeSource = "authored" | "resource" | "conversation";

/** Per-page index state derived from its chunks (read-only; not persisted). */
export type IndexingStatus = "indexed" | "lexical-only" | "pending";

export interface KnowledgePage {
  _id: string;
  title: string;
  content: string;
  plainText: string;
  source: KnowledgeSource;
  sourceId: string;
  domain: string | null;
  tags: string[];
  active: boolean;
  alwaysLoadForAgents: boolean;
  version: number;
  // OKF fields — optional in drafts; always populated on reads from the DB. A flat (non-space)
  // page leaves spaceId/path/resource null and frontmatterExtra {}.
  /** OKF: the space this page lives in, or null for a legacy/flat page. */
  spaceId?: string | null;
  /** OKF: slash-delimited page path within the space, e.g. "tables/orders" (no leading slash). */
  path?: string | null;
  /** OKF: the `resource` frontmatter field — canonical URI of the underlying asset. */
  resource?: string | null;
  /** OKF: the `type` frontmatter field — categorizes the page for the search `type` facet. */
  type?: string | null;
  /** OKF: round-trip store for unknown frontmatter keys from imported foreign spaces. */
  frontmatterExtra?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** An OKF space: the root of a hierarchical, cross-linked tree of pages. */
export interface KnowledgeSpace {
  _id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A directed cross-link parsed from a page body. `targetId` null = broken/unresolved link.
 * `targetSpaceName` null = the link stays inside the source's own space; non-null = a cross-space
 * link (`tf:page/<name>/<path>`) whose `targetSpaceId` is filled once that space exists.
 */
export interface KnowledgeLink {
  _id: string;
  spaceId: string;
  sourceId: string;
  targetPath: string;
  targetId: string | null;
  targetSpaceId: string | null;
  targetSpaceName: string | null;
  createdAt: Date;
}

/** An inbound link to a page — one row per page that links to it (the "Linked from" panel). */
export interface Backlink {
  sourceId: string;
  title: string;
  path: string | null;
  spaceId: string;
  spaceName: string;
}

/** A flat reference to one OKF page across all spaces — feeds the editor's `@`-mention Pages section. */
export interface SpacePageRef {
  pageId: string;
  spaceId: string;
  spaceName: string;
  path: string;
  title: string;
}

/** A space plus its active page count and last activity — feeds the Knowledge home space grid. */
export interface SpaceWithActivity {
  space: KnowledgeSpace;
  pageCount: number;
  /** Latest of the space's own update or any of its pages' updates. */
  lastActivity: Date;
}

/** A recently-edited page across all spaces — feeds the Knowledge home "Recently edited" list. */
export interface RecentPage extends SpacePageRef {
  updatedAt: Date;
}

/** A hand-authored index.md/log.md that overrides the auto-synthesized listing/changelog. */
export interface KnowledgeSpaceOverride {
  spaceId: string;
  /** Directory the override applies to; "" = space root. */
  dirPath: string;
  file: "index.md" | "log.md";
  content: string;
  updatedAt: Date;
}

export interface KnowledgeChunk {
  _id: string;
  pageId: string;
  chunkIndex: number;
  content: string;
  /** NULL when no embedding provider was available at index time (lexical-only). */
  embedding: number[] | null;
  model: string | null;
  dim: number | null;
  createdAt: Date;
}

export interface KnowledgeRevision {
  _id: string;
  pageId: string;
  revisionNumber: number;
  content: string;
  plainText: string;
  reason: string | null;
  createdAt: Date;
}

/** A new chunk to persist (before it has an id/createdAt). */
export interface ChunkInput {
  chunkIndex: number;
  content: string;
  /** `md5(content)` — content address used to skip re-embedding unchanged chunks on re-index. */
  contentHash: string;
  embedding: number[] | null;
  model: string | null;
  dim: number | null;
}

/**
 * Existing-chunk projection used by the re-index diff: enough to decide whether a new chunk at the
 * same `chunkIndex` can reuse this chunk's embedding (`contentHash` matches AND `model` is current).
 */
export interface ExistingChunk {
  chunkIndex: number;
  contentHash: string | null;
  embedding: number[] | null;
  model: string | null;
  dim: number | null;
}

export interface SearchFilters {
  domain?: string;
  source?: KnowledgeSource;
  tags?: string[];
  /** Scope search to one OKF space. Matched against the page's `space_id`. */
  spaceId?: string;
  /** Filter to one OKF `type` (e.g. "table", "playbook"). Matched against the page's `type`. */
  type?: string;
}

export interface SearchHit {
  pageId: string;
  chunkId: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  score: number;
}

/**
 * One page-level hit from the hybrid `query_knowledge` tool. Distinct from
 * `PageHit` in retrieval-service.ts (which carries highlightRanges); named to avoid that collision.
 * `snippet` is the best-matching chunk content for orientation — read the whole page with get_page.
 */
export interface QueryKnowledgeHit {
  pageId: string;
  title: string;
  snippet: string;
  source: KnowledgeSource;
  score: number;
  path?: string;
  spaceId?: string;
}

export interface SearchResults {
  results: SearchHit[];
  warnings: string[];
}

/** Aggregate index health, all derived from our own tables (no counters). */
export interface IndexStats {
  activePages: number;
  totalChunks: number;
  embeddedChunks: number;
  lexicalChunks: number;
  /** Max seconds an active page's content has been newer than its freshest chunk (0 = caught up). */
  maxLagSeconds: number | null;
}

/** Operational view of the async index queue (sourced from pg-boss; null when unavailable). */
export interface IndexQueueStats {
  pending: number;
  lastError: { message: string; failedAt: Date } | null;
}

/** Combined index-status report surfaced by `GET /api/v1/knowledge/index-status`. */
export interface IndexStatusReport {
  activePages: number;
  chunks: { total: number; embedded: number; lexicalOnly: number };
  indexLagSeconds: number | null;
  queue: IndexQueueStats | null;
}

/** Structural subset of `@tulipfarm/llm` EmbeddingService that knowledge depends on. */
export interface EmbeddingPort {
  isAvailable(): boolean;
  embedMany(values: string[]): Promise<{ embeddings: number[][]; dimension: number }>;
  getActive(): { provider: string; model: string; dimension: number | null } | null;
  getDimension(): number | null;
  consumePendingReindex(): boolean;
}
