// Knowledge/vector subsystem data types (P3, spec KN-V1). Internal docs use `_id`
// (mapped to `id` at the API boundary, like the rest of the codebase). Markdown lives
// in `content`; `plainText` is the indexed form.

export type KnowledgeSource = "authored" | "resource" | "conversation";

/** Per-document index state derived from its chunks (read-only; not persisted). */
export type IndexingStatus = "indexed" | "lexical-only" | "pending";

export interface KnowledgeDocument {
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
  // OKF fields — optional in drafts; always populated on reads from the DB. A flat (non-bundle)
  // document leaves bundleId/path/resource null and frontmatterExtra {}.
  /** OKF: the bundle this concept lives in, or null for a legacy/flat document. */
  bundleId?: string | null;
  /** OKF: slash-delimited concept path within the bundle, e.g. "tables/orders" (no leading slash). */
  path?: string | null;
  /** OKF: the `resource` frontmatter field — canonical URI of the underlying asset. */
  resource?: string | null;
  /** OKF: round-trip store for unknown frontmatter keys from imported foreign bundles. */
  frontmatterExtra?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** An OKF bundle: the root of a hierarchical, cross-linked tree of concept documents. */
export interface KnowledgeBundle {
  _id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A directed cross-link parsed from a concept body. `targetId` null = broken/unresolved link.
 * `targetBundleName` null = the link stays inside the source's own bundle; non-null = a cross-space
 * link (`tf:page/<name>/<path>`) whose `targetBundleId` is filled once that bundle exists.
 */
export interface KnowledgeLink {
  _id: string;
  bundleId: string;
  sourceId: string;
  targetPath: string;
  targetId: string | null;
  targetBundleId: string | null;
  targetBundleName: string | null;
  createdAt: Date;
}

/** An inbound link to a concept — one row per page that links to it (the "Linked from" panel). */
export interface Backlink {
  sourceId: string;
  title: string;
  path: string | null;
  bundleId: string;
  bundleName: string;
}

/** A flat reference to one OKF page across all bundles — feeds the editor's `@`-mention Pages section. */
export interface BundlePageRef {
  documentId: string;
  bundleId: string;
  bundleName: string;
  path: string;
  title: string;
}

/** A space plus its active page count and last activity — feeds the Knowledge home space grid. */
export interface BundleWithActivity {
  bundle: KnowledgeBundle;
  pageCount: number;
  /** Latest of the bundle's own update or any of its pages' updates. */
  lastActivity: Date;
}

/** A recently-edited page across all spaces — feeds the Knowledge home "Recently edited" list. */
export interface RecentPage extends BundlePageRef {
  updatedAt: Date;
}

/** A hand-authored index.md/log.md that overrides the auto-synthesized listing/changelog. */
export interface KnowledgeBundleOverride {
  bundleId: string;
  /** Directory the override applies to; "" = bundle root. */
  dirPath: string;
  file: "index.md" | "log.md";
  content: string;
  updatedAt: Date;
}

export interface KnowledgeChunk {
  _id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  /** NULL when no embedding provider was available at index time (lexical-only). */
  embedding: number[] | null;
  model: string | null;
  dim: number | null;
  createdAt: Date;
}

export interface KnowledgeCollection {
  _id: string;
  name: string;
  description: string | null;
  domain: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeRevision {
  _id: string;
  documentId: string;
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
  embedding: number[] | null;
  model: string | null;
  dim: number | null;
}

export interface SearchFilters {
  domain?: string;
  source?: KnowledgeSource;
  tags?: string[];
}

export interface SearchHit {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  score: number;
}

export interface SearchResults {
  results: SearchHit[];
  warnings: string[];
}

/** Structural subset of `@tulipfarm/llm` EmbeddingService that knowledge depends on. */
export interface EmbeddingPort {
  isAvailable(): boolean;
  embedMany(values: string[]): Promise<{ embeddings: number[][]; dimension: number }>;
  getActive(): { provider: string; model: string; dimension: number | null } | null;
  getDimension(): number | null;
  consumePendingReindex(): boolean;
}
