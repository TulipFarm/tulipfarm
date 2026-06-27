import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "../pagination";
import type { KnowledgeBundleOverrideRepo } from "./bundle-overrides-repo";
import type { BundlePatch, KnowledgeBundleRepo } from "./bundles-repo";
import type { KnowledgeChunkRepo } from "./chunks-repo";
import { indexDocument, reindexAll } from "./index-service";
import type { KnowledgeLinksRepo } from "./links-repo";
import { parseOkf, resolveLink, rewriteCrossPageBundleName } from "./okf/parse";
import { type IndexEntry, renderIndex } from "./okf/synthesize";
import type {
  DocumentListOpts,
  KnowledgeCollectionRepo,
  KnowledgeDocumentRepo,
  KnowledgeRevisionRepo,
} from "./repo";
import { search } from "./search-service";
import type {
  Backlink,
  BundlePageRef,
  BundleWithActivity,
  EmbeddingPort,
  IndexingStatus,
  KnowledgeBundle,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeRevision,
  KnowledgeSource,
  RecentPage,
  SearchFilters,
  SearchResults,
} from "./types";

function normalizeConceptPath(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** First non-heading, non-empty body line — a concept's index/preview description. */
function snippet(text: string, max = 140): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---"));
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

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

export interface CreateBundleInput {
  name: string;
  description?: string | null;
}

export type CreateBundleResult =
  | { ok: true; bundle: KnowledgeBundle }
  | { ok: false; reason: "name_taken" | "okf_unavailable" };

export interface WriteConceptInput {
  bundleId: string;
  path: string;
  /** Full OKF concept markdown (frontmatter + body). */
  content: string;
  /** Reason recorded on the history revision this write snapshots (internal callers, e.g. rename). */
  reason?: string | null;
}

export type WriteConceptResult =
  | { ok: true; document: KnowledgeDocument }
  | { ok: true; override: true }
  | { ok: false; reason: "okf_unavailable" | "bundle_not_found" | "invalid_okf" };

/** Thrown when a bundle rename collides with a name another bundle already holds (→ HTTP 409). */
export class BundleNameTakenError extends Error {
  constructor(name: string) {
    super(`bundle name already in use: ${name}`);
    this.name = "BundleNameTakenError";
  }
}

export interface BundleGraph {
  nodes: Array<{ id: string; path: string | null; title: string }>;
  edges: Array<{
    sourceId: string;
    targetId: string | null;
    targetPath: string;
    broken: boolean;
    /** Set when the edge points into another bundle (cross-space); null for same-bundle edges. */
    targetBundleName: string | null;
    /** The resolved id of that other bundle, when it exists; null while unresolved. */
    targetBundleId: string | null;
  }>;
  truncated: boolean;
}

export interface KnowledgeServiceDeps {
  documents: KnowledgeDocumentRepo;
  chunks: KnowledgeChunkRepo;
  collections: KnowledgeCollectionRepo;
  revisions: KnowledgeRevisionRepo;
  embeddings: EmbeddingPort;
  /** When set, document writes enqueue async (re)indexing instead of indexing inline. */
  enqueueIndex?: (documentId: string) => Promise<void>;
  /** OKF bundle repos — optional; required only for the OKF bundle/concept methods. */
  bundles?: KnowledgeBundleRepo;
  links?: KnowledgeLinksRepo;
  overrides?: KnowledgeBundleOverrideRepo;
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

  /**
   * A document fetched only when live — a missing OR soft-deleted page reads as null. Agent tools use
   * this so a deleted page is never surfaced or cited (its wiki url would 404 for the user).
   */
  async getActiveDocument(id: string): Promise<KnowledgeDocument | null> {
    const doc = await this.deps.documents.getById(id);
    return doc?.active ? doc : null;
  }

  /** Fetch one OKF concept by its bundle + path — an exact lookup (no ranking), path normalized. */
  getConceptByPath(bundleId: string, path: string): Promise<KnowledgeDocument | null> {
    return this.deps.documents.getByBundlePath(bundleId, normalizeConceptPath(path));
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

  /**
   * Vector/lexical search. With `expandGraph`, each hit's directly-linked OKF neighbors are
   * appended (score 0) so related concepts travel together (graph-aware retrieval).
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
    const hitIds = [...new Set(base.results.map((r) => r.documentId))];
    const neighborIds = (await this.deps.links.getLinkedDocumentIds(hitIds)).filter(
      (id) => !hitIds.includes(id)
    );
    if (neighborIds.length === 0) return base;
    const neighbors = await Promise.all(neighborIds.map((id) => this.deps.documents.getById(id)));
    const extra = neighbors
      .filter((d): d is KnowledgeDocument => Boolean(d?.active))
      // Scope-preserving: a bundle-scoped search must not leak neighbors from other bundles. Graph
      // links cross spaces, so without this a b1 page that links to a b2 page would surface b2.
      .filter((d) => !filters.bundleId || d.bundleId === filters.bundleId)
      .map((d) => ({
        documentId: d._id,
        chunkId: `graph:${d._id}`,
        title: d.title,
        content: d.plainText.slice(0, 800),
        source: d.source,
        score: 0,
      }));
    return { results: [...base.results, ...extra], warnings: base.warnings };
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

  // ── OKF bundles ──────────────────────────────────────────────────────────────

  private okf(): {
    bundles: KnowledgeBundleRepo;
    links: KnowledgeLinksRepo;
    overrides: KnowledgeBundleOverrideRepo;
  } | null {
    const { bundles, links, overrides } = this.deps;
    return bundles && links && overrides ? { bundles, links, overrides } : null;
  }

  async createBundle(input: CreateBundleInput): Promise<CreateBundleResult> {
    const okf = this.okf();
    if (!okf) return { ok: false, reason: "okf_unavailable" };
    if (await okf.bundles.getByName(input.name)) return { ok: false, reason: "name_taken" };
    const now = new Date();
    const bundle: KnowledgeBundle = {
      _id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await okf.bundles.insert(bundle);
    return { ok: true, bundle };
  }

  async getBundle(id: string): Promise<KnowledgeBundle | null> {
    const okf = this.okf();
    return okf ? okf.bundles.getById(id) : null;
  }

  async listBundles(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeBundle>> {
    const okf = this.okf();
    if (!okf) return { items: [], nextCursor: null };
    return okf.bundles.list(opts);
  }

  async updateBundle(id: string, patch: BundlePatch): Promise<KnowledgeBundle | null> {
    const okf = this.okf();
    if (!okf) return null;
    const before = await okf.bundles.getById(id);
    if (!before) return null;
    // Reject a rename onto a name another bundle already holds (the UNIQUE index is the backstop).
    if (patch.name && patch.name !== before.name) {
      const clash = await okf.bundles.getByName(patch.name);
      if (clash && clash._id !== id) throw new BundleNameTakenError(patch.name);
    }
    let updated: KnowledgeBundle | null;
    try {
      updated = await okf.bundles.update(id, patch, new Date());
    } catch (err) {
      // The UNIQUE(name) index is the backstop if the pre-check raced a concurrent rename. Only a
      // name-column violation maps to "taken" — scoped here so 23505s from the rename rewrite below
      // (knowledge_links / knowledge_documents) propagate as real errors, not a misleading 409.
      if (patch.name && (err as { code?: string }).code === "23505") {
        throw new BundleNameTakenError(patch.name);
      }
      throw err;
    }
    if (updated && patch.name && before.name !== updated.name) {
      await this.renameCrossLinks(before.name, updated.name);
    }
    return updated;
  }

  /**
   * After a bundle is renamed, rewrite the `tf:page/<old>/…` links embedded in every doc that
   * references it (across all bundles) to the new name, re-running `writeConcept` so each doc's
   * body AND its `knowledge_links` rows re-extract consistently. Each rewritten doc gets a tagged
   * history revision. A final global resolve pass backfills any ids the per-doc writes missed.
   * No DB transaction (none available): order is rename → rewrite → resolve, so a partial failure
   * leaves at most a few stale inbound links rather than a half-renamed bundle.
   */
  private async renameCrossLinks(oldName: string, newName: string): Promise<void> {
    const okf = this.okf();
    if (!okf) return;
    const sourceIds = await okf.links.listSourceIdsByTargetBundleName(oldName);
    for (const sourceId of sourceIds) {
      const doc = await this.deps.documents.getById(sourceId);
      // Skip soft-deleted sources: their link rows persist, but re-writing one would flip it back to
      // active (upsertBySource forces active=true) — a rename must not resurrect a deleted page.
      if (!doc?.bundleId || doc.path == null || !doc.active) continue;
      const next = rewriteCrossPageBundleName(doc.content, oldName, newName);
      if (next === doc.content) continue;
      await this.writeConcept({
        bundleId: doc.bundleId,
        path: doc.path,
        content: next,
        reason: `bundle renamed ${oldName} → ${newName}`,
      });
    }
    // Safety net: a rename leaves the bundle's id (and each target page's id) intact, so any link row
    // still naming the old bundle — e.g. a doc whose body rewrite was skipped — only has a stale name
    // column. Fix it directly so backlinks/graph stay consistent regardless of the per-doc rewrites.
    await okf.links.renameTargetBundle(oldName, newName);
    await okf.links.resolveCrossBundleLinks();
  }

  async deleteBundle(id: string): Promise<boolean> {
    const okf = this.okf();
    return okf ? okf.bundles.delete(id) : false;
  }

  listBundleDocuments(bundleId: string): Promise<KnowledgeDocument[]> {
    return this.deps.documents.listByBundle(bundleId);
  }

  /**
   * Author or update one OKF concept from its full markdown. A reserved final path segment
   * (`index`/`log`) is stored as a directory override instead of a concept. Recomputes the
   * concept's outbound cross-links and (re)indexes only when the body changed.
   */
  async writeConcept(input: WriteConceptInput): Promise<WriteConceptResult> {
    const okf = this.okf();
    if (!okf) return { ok: false, reason: "okf_unavailable" };
    if (!(await okf.bundles.getById(input.bundleId)))
      return { ok: false, reason: "bundle_not_found" };

    const path = normalizeConceptPath(input.path);
    const last = path.split("/").at(-1);
    if (last === "index" || last === "log") {
      await okf.overrides.upsert({
        bundleId: input.bundleId,
        dirPath: dirOf(path),
        file: `${last}.md` as "index.md" | "log.md",
        content: input.content,
        updatedAt: new Date(),
      });
      return { ok: true, override: true };
    }

    const concept = parseOkf(input.content);
    if (!concept) return { ok: false, reason: "invalid_okf" };

    const prior = await this.deps.documents.getByBundlePath(input.bundleId, path);
    const now = new Date();
    const draft: KnowledgeDocument = {
      _id: prior?._id ?? randomUUID(),
      title: concept.title ?? last ?? path,
      content: input.content,
      plainText: concept.body,
      // Bundle concepts are always authored content — keeps the (source, source_id) upsert key
      // stable so it can't collide with the partial unique (bundle_id, path) index.
      source: "authored",
      sourceId: `okf:${input.bundleId}:${path}`,
      domain: concept.tf.domain,
      tags: concept.tags,
      active: concept.tf.active ?? true,
      alwaysLoadForAgents: concept.tf.alwaysLoadForAgents ?? false,
      version: 1,
      bundleId: input.bundleId,
      path,
      resource: concept.resource,
      frontmatterExtra: concept.extra,
      createdAt: prior?.createdAt ?? now,
      updatedAt: concept.timestamp ? new Date(concept.timestamp) : now,
    };
    const { _id } = await this.deps.documents.upsertBySource(draft);

    // History: snapshot the prior content as a revision whenever an existing concept's content
    // actually changes (creates have no prior; unchanged re-writes stay silent). `reason` is set by
    // internal callers like bundle rename; ordinary edits leave it null.
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
      concept.links.map(async (raw) => {
        const targetPath = resolveLink(path, raw);
        const target = await this.deps.documents.getByBundlePath(input.bundleId, targetPath);
        // A soft-deleted target must read as broken (targetId null), not as a resolved live link.
        return { targetPath, targetId: target?.active ? target._id : null };
      })
    );
    const crossSpace = await Promise.all(
      concept.crossLinks.map(async (cl) => {
        const targetBundle = await okf.bundles.getByName(cl.bundleName);
        const target = targetBundle
          ? await this.deps.documents.getByBundlePath(targetBundle._id, cl.path)
          : null;
        return {
          targetPath: cl.path,
          targetId: target?.active ? target._id : null,
          targetBundleName: cl.bundleName,
          targetBundleId: targetBundle?._id ?? null,
        };
      })
    );
    await okf.links.replaceForDocument(_id, input.bundleId, [...sameSpace, ...crossSpace]);

    const canonical = await this.deps.documents.getById(_id);
    if (!canonical) return { ok: false, reason: "invalid_okf" };
    if (!prior || prior.plainText !== concept.body) await this.afterWrite(canonical);
    return { ok: true, document: canonical };
  }

  /** Progressive-disclosure listing for a directory: an authored index.md override, else synthesized. */
  async navigateBundle(bundleId: string, dirPath: string): Promise<string | null> {
    const okf = this.okf();
    if (!okf) return null;
    if (!(await okf.bundles.getById(bundleId))) return null;
    const dir = normalizeConceptPath(dirPath);
    const override = await okf.overrides.get(bundleId, dir, "index.md");
    if (override) return override.content;
    const docs = await this.deps.documents.listByBundle(bundleId);
    const entries: IndexEntry[] = docs.map((d) => ({
      path: d.path ?? "",
      title: d.title,
      description: snippet(d.plainText),
    }));
    return renderIndex(dir, entries);
  }

  /** Node + edge list for a bundle's cross-link graph (capped for payload safety). */
  async getBundleGraph(bundleId: string): Promise<BundleGraph | null> {
    const okf = this.okf();
    if (!okf) return null;
    if (!(await okf.bundles.getById(bundleId))) return null;
    const NODE_CAP = 500;
    const EDGE_CAP = 1000;
    const docs = await this.deps.documents.listByBundle(bundleId);
    const allEdges = await okf.links.getGraphForBundle(bundleId);
    const nodes = docs.slice(0, NODE_CAP).map((d) => ({
      id: d._id,
      path: d.path ?? null,
      title: d.title,
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
        targetBundleName: e.targetBundleName,
        targetBundleId: e.targetBundleId,
      }));
    return { nodes, edges, truncated: docs.length > NODE_CAP || allEdges.length > EDGE_CAP };
  }

  /** Pages that link to a concept (same- or cross-space) — the "Linked from" panel. */
  async getBacklinks(documentId: string): Promise<Backlink[] | null> {
    const okf = this.okf();
    if (!okf) return null;
    const doc = await this.deps.documents.getById(documentId);
    if (!doc?.bundleId || doc.path == null) return null;
    const bundle = await okf.bundles.getById(doc.bundleId);
    if (!bundle) return null;
    return okf.links.getBacklinks({
      documentId,
      bundleId: doc.bundleId,
      bundleName: bundle.name,
      path: doc.path,
    });
  }

  /** Flat list of every OKF page across all bundles — feeds the editor's `@`-mention Pages section. */
  async listAllPages(): Promise<BundlePageRef[]> {
    const okf = this.okf();
    if (!okf) return [];
    return this.deps.documents.listAllBundlePages();
  }

  /** Knowledge home overview: every space with page count + last activity, plus recently-edited pages. */
  async getKnowledgeOverview(
    recentLimit: number
  ): Promise<{ spaces: BundleWithActivity[]; recent: RecentPage[] }> {
    const okf = this.okf();
    if (!okf) return { spaces: [], recent: [] };
    const [spaces, recent] = await Promise.all([
      okf.bundles.listWithActivity(),
      this.deps.documents.listRecentPages(recentLimit),
    ]);
    return { spaces, recent };
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
