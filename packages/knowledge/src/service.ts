import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import type { KnowledgeLinksRepo } from "./links-repo";
import type { PageRetrievalService } from "./page-search-adapter";
import type { KnowledgePageRepo, KnowledgeRevisionRepo, PageListOpts } from "./repo";
import type { RetrievalDeps } from "./retrieve";
import {
  afterWrite,
  backfillMissing,
  type IngestSourceInput,
  indexStatus,
  ingestSource,
  reindexById,
  reindexTargeted,
  runReindexIfPending,
} from "./service-indexing";
import { type HybridSearchContext, hybridSearchPages, search } from "./service-search";
import {
  type CreateSpaceInput,
  type CreateSpaceResult,
  createSpace,
  deleteSpace,
  getBacklinks,
  getKnowledgeOverview,
  getSpace,
  getSpaceGraph,
  listAllPages,
  listSpacePages,
  listSpaces,
  navigateSpace,
  normalizePagePath,
  type SpaceGraph,
  SpaceNameTakenError,
  updateSpace,
  type WritePageInput,
  type WritePageResult,
  writePage,
} from "./service-spaces";
import type { KnowledgeSpaceOverrideRepo } from "./space-overrides-repo";
import type { KnowledgeSpaceRepo, SpacePatch } from "./spaces-repo";
import type {
  Backlink,
  EmbeddingPort,
  IndexingStatus,
  IndexQueueStats,
  IndexStatusReport,
  KnowledgePage,
  KnowledgeRevision,
  KnowledgeSpace,
  QueryKnowledgeHit,
  RecentPage,
  SearchFilters,
  SearchResults,
  SpacePageRef,
  SpaceWithActivity,
} from "./types";

export type {
  CreateSpaceInput,
  CreateSpaceResult,
  HybridSearchContext,
  IngestSourceInput,
  SpaceGraph,
  WritePageInput,
  WritePageResult,
};
export { SpaceNameTakenError };

export interface CreatePageInput {
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
}

export interface UpdatePageInput {
  title?: string;
  content?: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
  active?: boolean;
}

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "conflict" };

export interface KnowledgeServiceDeps {
  pages: KnowledgePageRepo;
  chunks: KnowledgeChunkRepo;
  revisions: KnowledgeRevisionRepo;
  embeddings: EmbeddingPort;
  /** Page-level lexical retrieval — the lexical arm of `hybridSearchPages`. */
  retrieval?: PageRetrievalService;
  /** When set, page writes enqueue async (re)indexing instead of indexing inline. */
  enqueueIndex?: (pageId: string) => Promise<void>;
  /** Async index queue stats; absent means index-status omits queue info. */
  indexQueueStats?: () => Promise<IndexQueueStats>;
  /** OKF space repos — optional; required only for the OKF space/page methods. */
  spaces?: KnowledgeSpaceRepo;
  links?: KnowledgeLinksRepo;
  overrides?: KnowledgeSpaceOverrideRepo;
  /** ACL-first source retrieval fused into `query_knowledge` when present. */
  sourceRetrieval?: RetrievalDeps;
}

/** Shared Knowledge core; V1 `plainText` is trimmed markdown. */
export class KnowledgeService {
  constructor(private readonly deps: KnowledgeServiceDeps) {}

  // ── pages ────────────────────────────────────────────────────────────────────

  async createPage(input: CreatePageInput): Promise<KnowledgePage> {
    const now = new Date();
    const id = randomUUID();
    const page: KnowledgePage = {
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
    await this.deps.pages.insert(page);
    await afterWrite(this.deps, page);
    return page;
  }

  getPage(id: string): Promise<KnowledgePage | null> {
    return this.deps.pages.getById(id);
  }

  /** Fetch only live pages; missing or soft-deleted pages read as null. */
  async getActivePage(id: string): Promise<KnowledgePage | null> {
    const page = await this.deps.pages.getById(id);
    return page?.active ? page : null;
  }

  /** Fetch one OKF page by its space + path — an exact lookup (no ranking), path normalized. */
  getPageByPath(spaceId: string, path: string): Promise<KnowledgePage | null> {
    return this.deps.pages.getBySpacePath(spaceId, normalizePagePath(path));
  }

  listPages(opts: PageListOpts): Promise<PaginatedResult<KnowledgePage>> {
    return this.deps.pages.list(opts);
  }

  /** True if at least one active knowledge page exists — the onboarding "knowledge done" signal. */
  hasAnyKnowledgePage(): Promise<boolean> {
    return this.deps.pages.hasAnyActive();
  }

  /** Derived read-only index state for a page (from its chunks). */
  getIndexingStatus(pageId: string): Promise<IndexingStatus> {
    return this.deps.chunks.getIndexingStatus(pageId);
  }

  /** Batch index states keyed by page id (for list responses). */
  getIndexingStatuses(pageIds: string[]): Promise<Map<string, IndexingStatus>> {
    return this.deps.chunks.getIndexingStatuses(pageIds);
  }

  async updatePage(
    id: string,
    input: UpdatePageInput,
    expectedVersion: number
  ): Promise<WriteOutcome<KnowledgePage>> {
    const existing = await this.deps.pages.getById(id);
    if (!existing) return { ok: false, reason: "not_found" };

    const content = input.content ?? existing.content;
    const next: KnowledgePage = {
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
    const ok = await this.deps.pages.replaceOne(id, expectedVersion, next);
    if (!ok) return { ok: false, reason: "conflict" };

    // Snapshot the prior state as a revision.
    await this.deps.revisions.append(randomUUID(), id, existing.content, existing.plainText, null);
    // Re-index only when the indexed text changed.
    if (input.content !== undefined) await afterWrite(this.deps, next);
    return { ok: true, value: next };
  }

  async deletePage(id: string): Promise<boolean> {
    const deleted = await this.deps.pages.softDelete(id);
    if (deleted) await this.deps.chunks.deleteByPage(id);
    return deleted;
  }

  // ── revisions ────────────────────────────────────────────────────────────────

  async createRevision(
    pageId: string,
    content: string,
    plainText: string,
    reason: string | null
  ): Promise<number | null> {
    if (!(await this.deps.pages.getById(pageId))) return null;
    return this.deps.revisions.append(randomUUID(), pageId, content, plainText, reason);
  }

  listRevisions(pageId: string): Promise<KnowledgeRevision[]> {
    return this.deps.revisions.list(pageId);
  }

  // ── search + governance ──────────────────────────────────────────────────────

  /** Vector/lexical search; `expandGraph` appends direct OKF neighbors with score 0. */
  search(
    query: string,
    filters: SearchFilters,
    limit: number,
    opts?: { expandGraph?: boolean }
  ): Promise<SearchResults> {
    return search(this.deps, query, filters, limit, opts);
  }

  /** Tool retrieval fuses vector and lexical arms with RRF (k=60) before hydration/rerank. */
  hybridSearchPages(
    query: string,
    filters: SearchFilters,
    limit: number,
    context?: HybridSearchContext
  ): Promise<{ results: QueryKnowledgeHit[]; warnings: string[] }> {
    return hybridSearchPages(this.deps, query, filters, limit, context);
  }

  governancePages(): Promise<KnowledgePage[]> {
    return this.deps.pages.governancePages();
  }

  // ── OKF spaces ───────────────────────────────────────────────────────────────

  createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult> {
    return createSpace(this.deps, input);
  }

  getSpace(id: string): Promise<KnowledgeSpace | null> {
    return getSpace(this.deps, id);
  }

  listSpaces(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeSpace>> {
    return listSpaces(this.deps, opts);
  }

  updateSpace(id: string, patch: SpacePatch): Promise<KnowledgeSpace | null> {
    return updateSpace(this.deps, id, patch);
  }

  deleteSpace(id: string): Promise<boolean> {
    return deleteSpace(this.deps, id);
  }

  listSpacePages(spaceId: string): Promise<KnowledgePage[]> {
    return listSpacePages(this.deps, spaceId);
  }

  /** Write an OKF page; final `index`/`log` path segments become directory overrides. */
  writePage(input: WritePageInput): Promise<WritePageResult> {
    return writePage(this.deps, input);
  }

  /** Directory listing: authored index.md override, else synthesized. */
  navigateSpace(spaceId: string, dirPath: string): Promise<string | null> {
    return navigateSpace(this.deps, spaceId, dirPath);
  }

  /** Node + edge list for a space's cross-link graph (capped for payload safety). */
  getSpaceGraph(spaceId: string): Promise<SpaceGraph | null> {
    return getSpaceGraph(this.deps, spaceId);
  }

  /** Pages that link to a page (same- or cross-space) — the "Linked from" panel. */
  getBacklinks(pageId: string): Promise<Backlink[] | null> {
    return getBacklinks(this.deps, pageId);
  }

  /** Flat list of every OKF page across spaces for editor `@`-mentions. */
  listAllPages(): Promise<SpacePageRef[]> {
    return listAllPages(this.deps);
  }

  /** Knowledge home overview: spaces with counts/activity plus recently-edited pages. */
  getKnowledgeOverview(
    recentLimit: number
  ): Promise<{ spaces: SpaceWithActivity[]; recent: RecentPage[] }> {
    return getKnowledgeOverview(this.deps, recentLimit);
  }

  reindexById(id: string): Promise<void> {
    return reindexById(this.deps, id);
  }

  /** Upsert a resource/conversation-sourced page and (re)index it. */
  ingestSource(input: IngestSourceInput): Promise<KnowledgePage | null> {
    return ingestSource(this.deps, input);
  }

  /** Manual re-index; `pageId` and `spaceId` never fall back to full re-index. */
  reindexTargeted(opts: { pageId?: string; spaceId?: string }): Promise<number> {
    return reindexTargeted(this.deps, opts);
  }

  /** Backfill active pages with missing/stale embeddings; no provider returns 0. */
  backfillMissing(): Promise<number> {
    return backfillMissing(this.deps);
  }

  /** DB-derived index health (+ pg-boss queue stats when wired). */
  indexStatus(): Promise<IndexStatusReport> {
    return indexStatus(this.deps);
  }

  /**
   * Full re-index when the stored vectors no longer match the active embedding model (KN-V1-002).
   *
   * The in-memory flag only sees a change that happens inside one process lifetime. An operator who
   * edits the embedding model and restarts loses it entirely, and every stored vector then sits at
   * a width `searchVector` will never match — vector recall silently drops to zero. So the stored
   * corpus, not process memory, is the authority; the flag is only a fast path.
   */
  runReindexIfPending(): Promise<boolean> {
    return runReindexIfPending(this.deps);
  }
}
