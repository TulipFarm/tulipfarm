import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "../pagination";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import { indexDocument, reindexAll } from "./index-service";
import type {
  DocumentListOpts,
  KnowledgeCollectionRepo,
  KnowledgeDocumentRepo,
  KnowledgeRevisionRepo,
} from "./repo";
import { search } from "./search-service";
import type {
  EmbeddingPort,
  IndexingStatus,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeRevision,
  KnowledgeSource,
  SearchFilters,
  SearchResults,
} from "./types";

export interface CreateDocumentInput {
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
}

export interface UpdateDocumentInput {
  title?: string;
  content?: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
  active?: boolean;
}

export interface CreateCollectionInput {
  name: string;
  description?: string | null;
  domain?: string | null;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string | null;
  domain?: string | null;
}

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "conflict" };

export type AddToCollectionResult = "ok" | "collection_not_found" | "document_not_found";

export interface IngestSourceInput {
  source: KnowledgeSource;
  sourceId: string;
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
}

export interface KnowledgeServiceDeps {
  documents: KnowledgeDocumentRepo;
  chunks: KnowledgeChunkRepo;
  collections: KnowledgeCollectionRepo;
  revisions: KnowledgeRevisionRepo;
  embeddings: EmbeddingPort;
  /** When set, document writes enqueue async (re)indexing instead of indexing inline. */
  enqueueIndex?: (documentId: string) => Promise<void>;
}

/**
 * The one tested core every caller (routes, agent tools, governance injection, source
 * adapters) goes through. Composes the repos + chunker + index/search services + the
 * embedding provider. V1: `plainText` is the trimmed markdown (proper stripping later).
 */
export class KnowledgeService {
  constructor(private readonly deps: KnowledgeServiceDeps) {}

  // ── documents ────────────────────────────────────────────────────────────────

  async createDocument(input: CreateDocumentInput): Promise<KnowledgeDocument> {
    const now = new Date();
    const id = randomUUID();
    const doc: KnowledgeDocument = {
      _id: id,
      title: input.title,
      content: input.content,
      plainText: input.content.trim(),
      source: "authored",
      sourceId: id,
      domain: input.domain ?? null,
      tags: input.tags ?? [],
      active: true,
      alwaysLoadForAgents: input.alwaysLoadForAgents ?? false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.documents.insert(doc);
    await this.afterWrite(doc);
    return doc;
  }

  getDocument(id: string): Promise<KnowledgeDocument | null> {
    return this.deps.documents.getById(id);
  }

  listDocuments(opts: DocumentListOpts): Promise<PaginatedResult<KnowledgeDocument>> {
    return this.deps.documents.list(opts);
  }

  /** Derived read-only index state for a document (from its chunks). */
  getIndexingStatus(documentId: string): Promise<IndexingStatus> {
    return this.deps.chunks.getIndexingStatus(documentId);
  }

  /** Batch index states keyed by document id (for list responses). */
  getIndexingStatuses(documentIds: string[]): Promise<Map<string, IndexingStatus>> {
    return this.deps.chunks.getIndexingStatuses(documentIds);
  }

  async updateDocument(
    id: string,
    input: UpdateDocumentInput,
    expectedVersion: number
  ): Promise<WriteOutcome<KnowledgeDocument>> {
    const existing = await this.deps.documents.getById(id);
    if (!existing) return { ok: false, reason: "not_found" };

    const content = input.content ?? existing.content;
    const next: KnowledgeDocument = {
      ...existing,
      title: input.title ?? existing.title,
      content,
      plainText: content.trim(),
      domain: input.domain !== undefined ? input.domain : existing.domain,
      tags: input.tags ?? existing.tags,
      alwaysLoadForAgents: input.alwaysLoadForAgents ?? existing.alwaysLoadForAgents,
      active: input.active ?? existing.active,
      version: existing.version + 1,
      updatedAt: new Date(),
    };
    const ok = await this.deps.documents.replaceOne(id, expectedVersion, next);
    if (!ok) return { ok: false, reason: "conflict" };

    // Snapshot the prior state as a revision.
    await this.deps.revisions.append(randomUUID(), id, existing.content, existing.plainText, null);
    // Re-index only when the indexed text changed.
    if (input.content !== undefined) await this.afterWrite(next);
    return { ok: true, value: next };
  }

  async deleteDocument(id: string): Promise<boolean> {
    const deleted = await this.deps.documents.softDelete(id);
    if (deleted) await this.deps.chunks.deleteByDocument(id);
    return deleted;
  }

  // ── revisions ────────────────────────────────────────────────────────────────

  async createRevision(
    documentId: string,
    content: string,
    plainText: string,
    reason: string | null
  ): Promise<number | null> {
    if (!(await this.deps.documents.getById(documentId))) return null;
    return this.deps.revisions.append(randomUUID(), documentId, content, plainText, reason);
  }

  listRevisions(documentId: string): Promise<KnowledgeRevision[]> {
    return this.deps.revisions.list(documentId);
  }

  // ── search + governance ──────────────────────────────────────────────────────

  search(query: string, filters: SearchFilters, limit: number): Promise<SearchResults> {
    return search(query, filters, limit, {
      embeddings: this.deps.embeddings,
      chunksRepo: this.deps.chunks,
    });
  }

  governanceDocuments(): Promise<KnowledgeDocument[]> {
    return this.deps.documents.governanceDocuments();
  }

  // ── collections ──────────────────────────────────────────────────────────────

  async createCollection(input: CreateCollectionInput): Promise<KnowledgeCollection> {
    const now = new Date();
    const c: KnowledgeCollection = {
      _id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      domain: input.domain ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.collections.insert(c);
    return c;
  }

  getCollection(id: string): Promise<KnowledgeCollection | null> {
    return this.deps.collections.getById(id);
  }

  listCollections(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeCollection>> {
    return this.deps.collections.list(opts);
  }

  async updateCollection(
    id: string,
    input: UpdateCollectionInput,
    expectedVersion: number
  ): Promise<WriteOutcome<KnowledgeCollection>> {
    const existing = await this.deps.collections.getById(id);
    if (!existing) return { ok: false, reason: "not_found" };
    const next: KnowledgeCollection = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      domain: input.domain !== undefined ? input.domain : existing.domain,
      version: existing.version + 1,
      updatedAt: new Date(),
    };
    const ok = await this.deps.collections.replaceOne(id, expectedVersion, next);
    return ok ? { ok: true, value: next } : { ok: false, reason: "conflict" };
  }

  deleteCollection(id: string): Promise<boolean> {
    return this.deps.collections.delete(id);
  }

  async addToCollection(collectionId: string, documentId: string): Promise<AddToCollectionResult> {
    if (!(await this.deps.collections.getById(collectionId))) return "collection_not_found";
    const doc = await this.deps.documents.getById(documentId);
    if (!doc?.active) return "document_not_found";
    await this.deps.collections.addDocument(collectionId, documentId);
    return "ok";
  }

  removeFromCollection(collectionId: string, documentId: string): Promise<boolean> {
    return this.deps.collections.removeDocument(collectionId, documentId);
  }

  listCollectionDocumentIds(collectionId: string): Promise<string[]> {
    return this.deps.collections.listDocumentIds(collectionId);
  }

  // ── indexing (used by the pg-boss worker + adapters) ─────────────────────────

  indexDocument(doc: KnowledgeDocument): Promise<unknown> {
    return indexDocument(doc, this.deps.chunks, this.deps.embeddings);
  }

  async reindexById(id: string): Promise<void> {
    const doc = await this.deps.documents.getById(id);
    if (doc?.active) await this.indexDocument(doc);
  }

  /** Upsert a resource/conversation-sourced document and (re)index it. */
  async ingestSource(input: IngestSourceInput): Promise<KnowledgeDocument | null> {
    const now = new Date();
    const draft: KnowledgeDocument = {
      _id: randomUUID(),
      title: input.title,
      content: input.content,
      plainText: input.content.trim(),
      source: input.source,
      sourceId: input.sourceId,
      domain: input.domain ?? null,
      tags: input.tags ?? [],
      active: true,
      alwaysLoadForAgents: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { _id } = await this.deps.documents.upsertBySource(draft);
    const canonical = await this.deps.documents.getById(_id);
    if (canonical) await this.indexDocument(canonical);
    return canonical;
  }

  reindexAll(): Promise<number> {
    return reindexAll(this.deps.documents, this.deps.chunks, this.deps.embeddings);
  }

  /** Full re-index when the embedding dimension changed (KN-V1-002 guard). */
  async runReindexIfPending(): Promise<boolean> {
    if (!this.deps.embeddings.consumePendingReindex()) return false;
    await this.reindexAll();
    return true;
  }

  private async afterWrite(doc: KnowledgeDocument): Promise<void> {
    if (this.deps.enqueueIndex) await this.deps.enqueueIndex(doc._id);
    else await this.indexDocument(doc);
  }
}
