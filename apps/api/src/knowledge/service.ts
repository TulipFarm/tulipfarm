import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "../pagination";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import { indexPage, reindexAll } from "./index-service";
import type { KnowledgeLinksRepo } from "./links-repo";
import { parseOkf, resolveLink, rewriteCrossPageSpaceName } from "./okf/parse";
import { type IndexEntry, renderIndex } from "./okf/synthesize";
import type { KnowledgePageRepo, KnowledgeRevisionRepo, PageListOpts } from "./repo";
import { search } from "./search-service";
import type { KnowledgeSpaceOverrideRepo } from "./space-overrides-repo";
import type { KnowledgeSpaceRepo, SpacePatch } from "./spaces-repo";
import type {
  Backlink,
  EmbeddingPort,
  IndexingStatus,
  KnowledgePage,
  KnowledgeRevision,
  KnowledgeSource,
  KnowledgeSpace,
  RecentPage,
  SearchFilters,
  SearchResults,
  SpacePageRef,
  SpaceWithActivity,
} from "./types";

function normalizePagePath(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** First non-heading, non-empty body line — a page's index/preview description. */
function snippet(text: string, max = 140): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---"));
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

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

export interface IngestSourceInput {
  source: KnowledgeSource;
  sourceId: string;
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
}

export interface CreateSpaceInput {
  name: string;
  description?: string | null;
}

export type CreateSpaceResult =
  | { ok: true; space: KnowledgeSpace }
  | { ok: false; reason: "name_taken" | "okf_unavailable" };

export interface WritePageInput {
  spaceId: string;
  path: string;
  /** Full OKF page markdown (frontmatter + body). */
  content: string;
  /** Reason recorded on the history revision this write snapshots (internal callers, e.g. rename). */
  reason?: string | null;
}

export type WritePageResult =
  | { ok: true; page: KnowledgePage }
  | { ok: true; override: true }
  | { ok: false; reason: "okf_unavailable" | "space_not_found" | "invalid_okf" };

/** Thrown when a space rename collides with a name another space already holds (→ HTTP 409). */
export class SpaceNameTakenError extends Error {
  constructor(name: string) {
    super(`space name already in use: ${name}`);
    this.name = "SpaceNameTakenError";
  }
}

export interface SpaceGraph {
  nodes: Array<{ id: string; path: string | null; title: string }>;
  edges: Array<{
    sourceId: string;
    targetId: string | null;
    targetPath: string;
    broken: boolean;
    /** Set when the edge points into another space (cross-space); null for same-space edges. */
    targetSpaceName: string | null;
    /** The resolved id of that other space, when it exists; null while unresolved. */
    targetSpaceId: string | null;
  }>;
  truncated: boolean;
}

export interface KnowledgeServiceDeps {
  pages: KnowledgePageRepo;
  chunks: KnowledgeChunkRepo;
  revisions: KnowledgeRevisionRepo;
  embeddings: EmbeddingPort;
  /** When set, page writes enqueue async (re)indexing instead of indexing inline. */
  enqueueIndex?: (pageId: string) => Promise<void>;
  /** OKF space repos — optional; required only for the OKF space/page methods. */
  spaces?: KnowledgeSpaceRepo;
  links?: KnowledgeLinksRepo;
  overrides?: KnowledgeSpaceOverrideRepo;
}

/**
 * The one tested core every caller (routes, agent tools, governance injection, source
 * adapters) goes through. Composes the repos + chunker + index/search services + the
 * embedding provider. V1: `plainText` is the trimmed markdown (proper stripping later).
 */
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
    await this.afterWrite(page);
    return page;
  }

  getPage(id: string): Promise<KnowledgePage | null> {
    return this.deps.pages.getById(id);
  }

  /**
   * A page fetched only when live — a missing OR soft-deleted page reads as null. Agent tools use
   * this so a deleted page is never surfaced or cited (its wiki url would 404 for the user).
   */
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
    if (input.content !== undefined) await this.afterWrite(next);
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

  /**
   * Vector/lexical search. With `expandGraph`, each hit's directly-linked OKF neighbors are
   * appended (score 0) so related pages travel together (graph-aware retrieval).
   */
  async search(
    query: string,
    filters: SearchFilters,
    limit: number,
    opts?: { expandGraph?: boolean }
  ): Promise<SearchResults> {
    const base = await search(query, filters, limit, {
      embeddings: this.deps.embeddings,
      chunksRepo: this.deps.chunks,
    });
    if (!opts?.expandGraph || !this.deps.links) return base;
    const hitIds = [...new Set(base.results.map((r) => r.pageId))];
    const neighborIds = (await this.deps.links.getLinkedPageIds(hitIds)).filter(
      (id) => !hitIds.includes(id)
    );
    if (neighborIds.length === 0) return base;
    const neighbors = await Promise.all(neighborIds.map((id) => this.deps.pages.getById(id)));
    const extra = neighbors
      .filter((p): p is KnowledgePage => Boolean(p?.active))
      // Scope-preserving: a space-scoped search must not leak neighbors from other spaces. Graph
      // links cross spaces, so without this a s1 page that links to a s2 page would surface s2.
      .filter((p) => !filters.spaceId || p.spaceId === filters.spaceId)
      .map((p) => ({
        pageId: p._id,
        chunkId: `graph:${p._id}`,
        title: p.title,
        content: p.plainText.slice(0, 800),
        source: p.source,
        score: 0,
      }));
    return { results: [...base.results, ...extra], warnings: base.warnings };
  }

  governancePages(): Promise<KnowledgePage[]> {
    return this.deps.pages.governancePages();
  }

  // ── OKF spaces ───────────────────────────────────────────────────────────────

  private okf(): {
    spaces: KnowledgeSpaceRepo;
    links: KnowledgeLinksRepo;
    overrides: KnowledgeSpaceOverrideRepo;
  } | null {
    const { spaces, links, overrides } = this.deps;
    return spaces && links && overrides ? { spaces, links, overrides } : null;
  }

  async createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult> {
    const okf = this.okf();
    if (!okf) return { ok: false, reason: "okf_unavailable" };
    if (await okf.spaces.getByName(input.name)) return { ok: false, reason: "name_taken" };
    const now = new Date();
    const space: KnowledgeSpace = {
      _id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await okf.spaces.insert(space);
    return { ok: true, space };
  }

  async getSpace(id: string): Promise<KnowledgeSpace | null> {
    const okf = this.okf();
    return okf ? okf.spaces.getById(id) : null;
  }

  async listSpaces(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeSpace>> {
    const okf = this.okf();
    if (!okf) return { items: [], nextCursor: null };
    return okf.spaces.list(opts);
  }

  async updateSpace(id: string, patch: SpacePatch): Promise<KnowledgeSpace | null> {
    const okf = this.okf();
    if (!okf) return null;
    const before = await okf.spaces.getById(id);
    if (!before) return null;
    // Reject a rename onto a name another space already holds (the UNIQUE index is the backstop).
    if (patch.name && patch.name !== before.name) {
      const clash = await okf.spaces.getByName(patch.name);
      if (clash && clash._id !== id) throw new SpaceNameTakenError(patch.name);
    }
    let updated: KnowledgeSpace | null;
    try {
      updated = await okf.spaces.update(id, patch, new Date());
    } catch (err) {
      // The UNIQUE(name) index is the backstop if the pre-check raced a concurrent rename. Only a
      // name-column violation maps to "taken" — scoped here so 23505s from the rename rewrite below
      // (knowledge_links / knowledge_pages) propagate as real errors, not a misleading 409.
      if (patch.name && (err as { code?: string }).code === "23505") {
        throw new SpaceNameTakenError(patch.name);
      }
      throw err;
    }
    if (updated && patch.name && before.name !== updated.name) {
      await this.renameCrossLinks(before.name, updated.name);
    }
    return updated;
  }

  /**
   * After a space is renamed, rewrite the `tf:page/<old>/…` links embedded in every page that
   * references it (across all spaces) to the new name, re-running `writePage` so each page's
   * body AND its `knowledge_links` rows re-extract consistently. Each rewritten page gets a tagged
   * history revision. A final global resolve pass backfills any ids the per-page writes missed.
   * No DB transaction (none available): order is rename → rewrite → resolve, so a partial failure
   * leaves at most a few stale inbound links rather than a half-renamed space.
   */
  private async renameCrossLinks(oldName: string, newName: string): Promise<void> {
    const okf = this.okf();
    if (!okf) return;
    const sourceIds = await okf.links.listSourceIdsByTargetSpaceName(oldName);
    for (const sourceId of sourceIds) {
      const page = await this.deps.pages.getById(sourceId);
      // Skip soft-deleted sources: their link rows persist, but re-writing one would flip it back to
      // active (upsertBySource forces active=true) — a rename must not resurrect a deleted page.
      if (!page?.spaceId || page.path == null || !page.active) continue;
      const next = rewriteCrossPageSpaceName(page.content, oldName, newName);
      if (next === page.content) continue;
      await this.writePage({
        spaceId: page.spaceId,
        path: page.path,
        content: next,
        reason: `space renamed ${oldName} → ${newName}`,
      });
    }
    // Safety net: a rename leaves the space's id (and each target page's id) intact, so any link row
    // still naming the old space — e.g. a page whose body rewrite was skipped — only has a stale name
    // column. Fix it directly so backlinks/graph stay consistent regardless of the per-page rewrites.
    await okf.links.renameTargetSpace(oldName, newName);
    await okf.links.resolveCrossSpaceLinks();
  }

  async deleteSpace(id: string): Promise<boolean> {
    const okf = this.okf();
    return okf ? okf.spaces.delete(id) : false;
  }

  listSpacePages(spaceId: string): Promise<KnowledgePage[]> {
    return this.deps.pages.listBySpace(spaceId);
  }

  /**
   * Author or update one OKF page from its full markdown. A reserved final path segment
   * (`index`/`log`) is stored as a directory override instead of a page. Recomputes the
   * page's outbound cross-links and (re)indexes only when the body changed.
   */
  async writePage(input: WritePageInput): Promise<WritePageResult> {
    const okf = this.okf();
    if (!okf) return { ok: false, reason: "okf_unavailable" };
    if (!(await okf.spaces.getById(input.spaceId))) return { ok: false, reason: "space_not_found" };

    const path = normalizePagePath(input.path);
    const last = path.split("/").at(-1);
    if (last === "index" || last === "log") {
      await okf.overrides.upsert({
        spaceId: input.spaceId,
        dirPath: dirOf(path),
        file: `${last}.md` as "index.md" | "log.md",
        content: input.content,
        updatedAt: new Date(),
      });
      return { ok: true, override: true };
    }

    const parsed = parseOkf(input.content);
    if (!parsed) return { ok: false, reason: "invalid_okf" };

    const prior = await this.deps.pages.getBySpacePath(input.spaceId, path);
    const now = new Date();
    const draft: KnowledgePage = {
      _id: prior?._id ?? randomUUID(),
      title: parsed.title ?? last ?? path,
      content: input.content,
      plainText: parsed.body,
      // Space pages are always authored content — keeps the (source, source_id) upsert key
      // stable so it can't collide with the partial unique (space_id, path) index.
      source: "authored",
      sourceId: `okf:${input.spaceId}:${path}`,
      domain: parsed.tf.domain,
      tags: parsed.tags,
      active: parsed.tf.active ?? true,
      alwaysLoadForAgents: parsed.tf.alwaysLoadForAgents ?? false,
      version: 1,
      spaceId: input.spaceId,
      path,
      resource: parsed.resource,
      type: parsed.type,
      frontmatterExtra: parsed.extra,
      createdAt: prior?.createdAt ?? now,
      updatedAt: parsed.timestamp ? new Date(parsed.timestamp) : now,
    };
    const { _id } = await this.deps.pages.upsertBySource(draft);

    // History: snapshot the prior content as a revision whenever an existing page's content
    // actually changes (creates have no prior; unchanged re-writes stay silent). `reason` is set by
    // internal callers like space rename; ordinary edits leave it null.
    if (prior && prior.content !== input.content) {
      await this.deps.revisions.append(
        randomUUID(),
        prior._id,
        prior.content,
        prior.plainText,
        input.reason ?? null
      );
    }

    const sameSpace = await Promise.all(
      parsed.links.map(async (raw) => {
        const targetPath = resolveLink(path, raw);
        const target = await this.deps.pages.getBySpacePath(input.spaceId, targetPath);
        // A soft-deleted target must read as broken (targetId null), not as a resolved live link.
        return { targetPath, targetId: target?.active ? target._id : null };
      })
    );
    const crossSpace = await Promise.all(
      parsed.crossLinks.map(async (cl) => {
        const targetSpace = await okf.spaces.getByName(cl.spaceName);
        const target = targetSpace
          ? await this.deps.pages.getBySpacePath(targetSpace._id, cl.path)
          : null;
        return {
          targetPath: cl.path,
          targetId: target?.active ? target._id : null,
          targetSpaceName: cl.spaceName,
          targetSpaceId: targetSpace?._id ?? null,
        };
      })
    );
    await okf.links.replaceForPage(_id, input.spaceId, [...sameSpace, ...crossSpace]);

    const canonical = await this.deps.pages.getById(_id);
    if (!canonical) return { ok: false, reason: "invalid_okf" };
    if (!prior || prior.plainText !== parsed.body) await this.afterWrite(canonical);
    return { ok: true, page: canonical };
  }

  /** Progressive-disclosure listing for a directory: an authored index.md override, else synthesized. */
  async navigateSpace(spaceId: string, dirPath: string): Promise<string | null> {
    const okf = this.okf();
    if (!okf) return null;
    if (!(await okf.spaces.getById(spaceId))) return null;
    const dir = normalizePagePath(dirPath);
    const override = await okf.overrides.get(spaceId, dir, "index.md");
    if (override) return override.content;
    const pages = await this.deps.pages.listBySpace(spaceId);
    const entries: IndexEntry[] = pages.map((p) => ({
      path: p.path ?? "",
      title: p.title,
      description: snippet(p.plainText),
    }));
    return renderIndex(dir, entries);
  }

  /** Node + edge list for a space's cross-link graph (capped for payload safety). */
  async getSpaceGraph(spaceId: string): Promise<SpaceGraph | null> {
    const okf = this.okf();
    if (!okf) return null;
    if (!(await okf.spaces.getById(spaceId))) return null;
    const NODE_CAP = 500;
    const EDGE_CAP = 1000;
    const pages = await this.deps.pages.listBySpace(spaceId);
    const allEdges = await okf.links.getGraphForSpace(spaceId);
    const nodes = pages.slice(0, NODE_CAP).map((p) => ({
      id: p._id,
      path: p.path ?? null,
      title: p.title,
    }));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = allEdges
      .filter((e) => nodeIds.has(e.sourceId))
      .slice(0, EDGE_CAP)
      .map((e) => ({
        sourceId: e.sourceId,
        targetId: e.targetId,
        targetPath: e.targetPath,
        broken: e.targetId === null,
        targetSpaceName: e.targetSpaceName,
        targetSpaceId: e.targetSpaceId,
      }));
    return { nodes, edges, truncated: pages.length > NODE_CAP || allEdges.length > EDGE_CAP };
  }

  /** Pages that link to a page (same- or cross-space) — the "Linked from" panel. */
  async getBacklinks(pageId: string): Promise<Backlink[] | null> {
    const okf = this.okf();
    if (!okf) return null;
    const page = await this.deps.pages.getById(pageId);
    if (!page?.spaceId || page.path == null) return null;
    const space = await okf.spaces.getById(page.spaceId);
    if (!space) return null;
    return okf.links.getBacklinks({
      pageId: pageId,
      spaceId: page.spaceId,
      spaceName: space.name,
      path: page.path,
    });
  }

  /** Flat list of every OKF page across all spaces — feeds the editor's `@`-mention Pages section. */
  async listAllPages(): Promise<SpacePageRef[]> {
    const okf = this.okf();
    if (!okf) return [];
    return this.deps.pages.listAllSpacePages();
  }

  /** Knowledge home overview: every space with page count + last activity, plus recently-edited pages. */
  async getKnowledgeOverview(
    recentLimit: number
  ): Promise<{ spaces: SpaceWithActivity[]; recent: RecentPage[] }> {
    const okf = this.okf();
    if (!okf) return { spaces: [], recent: [] };
    const [spaces, recent] = await Promise.all([
      okf.spaces.listWithActivity(),
      this.deps.pages.listRecentPages(recentLimit),
    ]);
    return { spaces, recent };
  }

  // ── indexing (used by the pg-boss worker + adapters) ─────────────────────────

  indexPage(page: KnowledgePage): Promise<unknown> {
    return indexPage(page, this.deps.chunks, this.deps.embeddings);
  }

  async reindexById(id: string): Promise<void> {
    const page = await this.deps.pages.getById(id);
    if (page?.active) await this.indexPage(page);
  }

  /** Upsert a resource/conversation-sourced page and (re)index it. */
  async ingestSource(input: IngestSourceInput): Promise<KnowledgePage | null> {
    const now = new Date();
    const draft: KnowledgePage = {
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
    const { _id } = await this.deps.pages.upsertBySource(draft);
    const canonical = await this.deps.pages.getById(_id);
    if (canonical) await this.indexPage(canonical);
    return canonical;
  }

  reindexAll(): Promise<number> {
    return reindexAll(this.deps.pages, this.deps.chunks, this.deps.embeddings);
  }

  /** Full re-index when the embedding dimension changed (KN-V1-002 guard). */
  async runReindexIfPending(): Promise<boolean> {
    if (!this.deps.embeddings.consumePendingReindex()) return false;
    await this.reindexAll();
    return true;
  }

  private async afterWrite(page: KnowledgePage): Promise<void> {
    if (this.deps.enqueueIndex) await this.deps.enqueueIndex(page._id);
    else await this.indexPage(page);
  }
}
