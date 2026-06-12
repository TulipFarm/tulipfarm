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
  createdAt: Date;
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
