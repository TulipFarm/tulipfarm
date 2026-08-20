// Knowledge/vector subsystem data types; `_id` maps to API `id`, `plainText` is indexed.

/**
 * Where a Page's content came from.
 *
 * `file` is a File a person explicitly added to Knowledge. It is a Source kind rather than a
 * connected provider because we hold the bytes and the ACL ourselves, so its readership is read
 * live from our own tables instead of being snapshotted from somebody else's.
 */
export type KnowledgeSource = "authored" | "resource" | "conversation" | "file";

/**
 * Who wrote a Page. Null on Pages that predate authorship being recorded — deliberately not
 * defaulted to `user`, which would label every Agent-written Page as human work.
 */
export type PageAuthorKind = "user" | "agent";

export interface PageAuthor {
  kind: PageAuthorKind;
  id: string;
}

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
  // Draft OKF fields may be absent; DB reads always populate them or null/defaults.
  spaceId?: string | null;
  path?: string | null;
  resource?: string | null;
  type?: string | null;
  frontmatterExtra?: Record<string, unknown>;
  /** The author of the most recent write. Null when unknown. */
  authorKind?: PageAuthorKind | null;
  authorId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeSpace {
  _id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Cross-space links carry targetSpaceName until the target space exists; null stays in-space. */
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

export interface Backlink {
  sourceId: string;
  title: string;
  path: string | null;
  spaceId: string;
  spaceName: string;
}

export interface SpacePageRef {
  pageId: string;
  spaceId: string;
  spaceName: string;
  path: string;
  title: string;
  /** Carried here so the label travels with the Page into every listing, not just the Page view. */
  authorKind?: PageAuthorKind | null;
  authorId?: string | null;
}

/** One active, spaced Page reduced to what a per-principal activity roll-up needs. */
export interface SpacePageActivity {
  pageId: string;
  spaceId: string;
  updatedAt: Date;
}

export interface SpaceWithActivity {
  space: KnowledgeSpace;
  /**
   * Every active Page in the Space, ignoring who is asking. Not safe to render: a principal-aware
   * caller must roll its own up from `listSpacePageActivity` filtered through the read gate, or the
   * number tells a viewer how many Pages they are not being shown.
   */
  pageCount: number;
  /** Unfiltered in the same way, and for the same reason — a moving clock is a live-activity tell. */
  lastActivity: Date;
}

export interface RecentPage extends SpacePageRef {
  updatedAt: Date;
}

export interface KnowledgeSpaceOverride {
  spaceId: string;
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

export interface ChunkInput {
  chunkIndex: number;
  content: string;
  /** `md5(content)` — content address used to skip re-embedding unchanged chunks on re-index. */
  contentHash: string;
  embedding: number[] | null;
  model: string | null;
  dim: number | null;
}

/** Re-index diff projection: enough to decide whether embedding reuse is valid. */
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
  spaceId?: string;
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

/** Hybrid tool hit; snippet is orientation only, read the page for full content. */
export interface QueryKnowledgeHit {
  pageId: string;
  title: string;
  snippet: string;
  source: KnowledgeSource;
  /** Retrieval stack that produced the hit; source-stack hits also carry `provider`. */
  origin: "okf" | "knowledge_source";
  score: number;
  path?: string;
  spaceId?: string;
  provider?: string;
  sourceId?: string;
  chunkId?: string;
  classification?: readonly string[];
  revision?: string;
}

export interface SearchResults {
  results: SearchHit[];
  warnings: string[];
}

export interface IndexStats {
  activePages: number;
  totalChunks: number;
  embeddedChunks: number;
  lexicalChunks: number;
  /** Max seconds active page content is newer than its freshest chunk (0 = caught up). */
  maxLagSeconds: number | null;
}

export interface IndexQueueStats {
  pending: number;
  lastError: { message: string; failedAt: Date } | null;
}

export interface IndexStatusReport {
  activePages: number;
  chunks: { total: number; embedded: number; lexicalOnly: number };
  indexLagSeconds: number | null;
  queue: IndexQueueStats | null;
}

export interface EmbeddingPort {
  isAvailable(): boolean;
  embedMany(
    values: string[],
    signal?: AbortSignal
  ): Promise<{ embeddings: number[][]; dimension: number }>;
  getActive(): { provider: string; model: string; dimension: number | null } | null;
  getDimension(): number | null;
  /** Whether stored vectors are known to predate the active model. Must not clear the flag. */
  pendingReindex(): boolean;
  /** Called only after a re-index succeeded, so a failed one does not lose the signal. */
  clearPendingReindex(): void;
}
