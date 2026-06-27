/*
 * Read/write client for the knowledge API (documents, collections, search). Built on the shared
 * `apiGet`/`apiWrite`/`apiDelete` primitives in `api.ts` (cookie-first auth, CSRF echo, quoted
 * If-Match concurrency). React/Remix-free so it is unit-testable by mocking the global `fetch`.
 */
import { apiDelete, apiGet, apiSend, apiWrite } from "./api";

export type IndexingStatus = "indexed" | "lexical-only" | "pending";
export type KnowledgeSource = "authored" | "resource" | "conversation";

export type KnowledgeDocument = {
  id: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  sourceId: string;
  domain: string | null;
  tags: string[];
  active: boolean;
  alwaysLoadForAgents: boolean;
  version: number;
  // OKF-only; present on bundle concepts so a tag-filtered listing can link to its concept route.
  bundleId?: string | null;
  path?: string | null;
  // OKF concept metadata — also returned by `GET /documents/:id`, so a by-id load can render the view.
  resource?: string | null;
  createdAt: string;
  updatedAt: string;
  // Derived server-side from the document's chunks (read-only). Absent on older payloads.
  indexingStatus?: IndexingStatus;
};

export type KnowledgeCollection = {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CollectionWithCount = KnowledgeCollection & { docCount: number };

export type SearchHit = {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  score: number;
};

export type SearchResponse = { results: SearchHit[]; warnings: string[] };

export type DocPage = { items: KnowledgeDocument[]; nextCursor: string | null };
export type CollectionPage = { items: KnowledgeCollection[]; nextCursor: string | null };

export type DocumentInput = {
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
};

export type CollectionInput = {
  name: string;
  description?: string | null;
  domain?: string | null;
};

const BASE = "/api/v1/knowledge";
const enc = encodeURIComponent;

function pageQuery(cursor: string | undefined, limit: number): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

// ── documents ────────────────────────────────────────────────────────────────

export function listDocuments(cursor?: string, limit = 50, tags?: string[]): Promise<DocPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  if (tags && tags.length > 0) q.set("tags", tags.join(","));
  return apiGet<DocPage>(`${BASE}/documents?${q.toString()}`);
}

export function getDocument(id: string): Promise<KnowledgeDocument> {
  return apiGet<KnowledgeDocument>(`${BASE}/documents/${enc(id)}`);
}

export function createDocument(body: DocumentInput): Promise<KnowledgeDocument> {
  return apiWrite<KnowledgeDocument>("POST", `${BASE}/documents`, body);
}

// Full-replace update with optimistic concurrency; `version` becomes the quoted If-Match header.
export function updateDocument(
  id: string,
  version: number,
  body: Partial<DocumentInput>
): Promise<KnowledgeDocument> {
  return apiWrite<KnowledgeDocument>("PUT", `${BASE}/documents/${enc(id)}`, body, version);
}

export function deleteDocument(id: string): Promise<void> {
  return apiDelete(`${BASE}/documents/${enc(id)}`);
}

// Semantic search is a POST that reads — it still carries the CSRF echo header via `apiWrite`.
export function searchDocuments(query: string, limit = 10): Promise<SearchResponse> {
  return apiWrite<SearchResponse>("POST", `${BASE}/search`, { query, limit });
}

// A whole-page search hit (granularity "page"). Distinct from the chunk-level SearchHit.
export type PageSearchHit = {
  documentId: string;
  title: string;
  bundleId: string | null;
  path: string | null;
  snippet: string;
  highlightRanges: Array<[number, number]>;
  score: number;
};

export type PageSearchResponse = { results: PageSearchHit[]; warnings: string[] };

// Page-level human search (granularity "page"). A blank query returns recent pages server-side.
export function searchPages(
  query: string,
  opts: { bundleId?: string; type?: string; limit?: number } = {}
): Promise<PageSearchHit[]> {
  return apiWrite<PageSearchResponse>("POST", `${BASE}/search`, {
    query,
    granularity: "page",
    limit: opts.limit ?? 10,
    ...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
    ...(opts.type ? { type: opts.type } : {}),
  }).then((r) => r.results);
}

// ── collections ──────────────────────────────────────────────────────────────

export function listCollections(cursor?: string, limit = 50): Promise<CollectionPage> {
  return apiGet<CollectionPage>(`${BASE}/collections?${pageQuery(cursor, limit)}`);
}

export function getCollection(id: string): Promise<KnowledgeCollection> {
  return apiGet<KnowledgeCollection>(`${BASE}/collections/${enc(id)}`);
}

export function createCollection(body: CollectionInput): Promise<KnowledgeCollection> {
  return apiWrite<KnowledgeCollection>("POST", `${BASE}/collections`, body);
}

export function updateCollection(
  id: string,
  version: number,
  body: Partial<CollectionInput>
): Promise<KnowledgeCollection> {
  return apiWrite<KnowledgeCollection>("PUT", `${BASE}/collections/${enc(id)}`, body, version);
}

export function deleteCollection(id: string): Promise<void> {
  return apiDelete(`${BASE}/collections/${enc(id)}`);
}

export function getCollectionDocumentIds(id: string): Promise<{ documentIds: string[] }> {
  return apiGet<{ documentIds: string[] }>(`${BASE}/collections/${enc(id)}/documents`);
}

export function addDocToCollection(id: string, documentId: string): Promise<void> {
  // 204 (no body) → use apiSend, which sends a JSON body but parses no response.
  return apiSend("POST", `${BASE}/collections/${enc(id)}/documents`, { documentId });
}

export function removeDocFromCollection(id: string, docId: string): Promise<void> {
  return apiDelete(`${BASE}/collections/${enc(id)}/documents/${enc(docId)}`);
}

// Collections list enriched with a document count. No batch count endpoint exists, so we fan out one
// `documentIds` request per collection (N+1 — acceptable: collections are few). Documented, not optimized.
export async function listCollectionsWithCounts(
  cursor?: string,
  limit = 50
): Promise<{ items: CollectionWithCount[]; nextCursor: string | null }> {
  const page = await listCollections(cursor, limit);
  const items = await Promise.all(
    page.items.map(async (c) => {
      const { documentIds } = await getCollectionDocumentIds(c.id);
      return { ...c, docCount: documentIds.length };
    })
  );
  return { items, nextCursor: page.nextCursor };
}

// ── OKF bundles ────────────────────────────────────────────────────────────────

export type KnowledgeBundle = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

// A bundle member document. Carries the OKF-specific fields (path/resource) on top of the
// base knowledge-document shape; `content` is the full OKF markdown (frontmatter + body).
export type BundleDocument = {
  id: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  sourceId: string;
  domain: string | null;
  tags: string[];
  active: boolean;
  alwaysLoadForAgents: boolean;
  version: number;
  bundleId: string | null;
  path: string | null;
  resource: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BundlePage = { items: KnowledgeBundle[]; nextCursor: string | null };

export type BundleInput = {
  name: string;
  description?: string | null;
};

// A concept write either creates/replaces a concept document, or — when the path's last segment is
// `index`/`log` — records a directory override (200, no document returned).
export type ConceptWriteResult = BundleDocument | { override: true; path: string };

export type BundleGraphNode = {
  id: string;
  path: string | null;
  title: string;
};
export type BundleGraphEdge = {
  sourceId: string;
  targetId: string | null;
  targetPath: string;
  broken: boolean;
  /** Set when the edge points into another bundle (cross-space); null for same-bundle edges. */
  targetBundleName: string | null;
  /** The resolved id of that other bundle, when it exists; null while unresolved. */
  targetBundleId: string | null;
};
export type BundleGraph = {
  nodes: BundleGraphNode[];
  edges: BundleGraphEdge[];
  truncated: boolean;
};

export function listBundles(cursor?: string, limit = 50): Promise<BundlePage> {
  return apiGet<BundlePage>(`${BASE}/bundles?${pageQuery(cursor, limit)}`);
}

export function getBundle(id: string): Promise<KnowledgeBundle> {
  return apiGet<KnowledgeBundle>(`${BASE}/bundles/${enc(id)}`);
}

export function createBundle(body: BundleInput): Promise<KnowledgeBundle> {
  return apiWrite<KnowledgeBundle>("POST", `${BASE}/bundles`, body);
}

export function updateBundle(id: string, body: Partial<BundleInput>): Promise<KnowledgeBundle> {
  return apiWrite<KnowledgeBundle>("PUT", `${BASE}/bundles/${enc(id)}`, body);
}

export function deleteBundle(id: string): Promise<void> {
  return apiDelete(`${BASE}/bundles/${enc(id)}`);
}

export function listBundleDocuments(id: string): Promise<{ items: BundleDocument[] }> {
  return apiGet<{ items: BundleDocument[] }>(`${BASE}/bundles/${enc(id)}/documents`);
}

// Author/replace a concept (or record a directory override). The server parses/validates the OKF
// `content`; a 400 carries the validation message (surfaced by the form).
export function writeConcept(
  id: string,
  path: string,
  content: string
): Promise<ConceptWriteResult> {
  return apiWrite<ConceptWriteResult>("POST", `${BASE}/bundles/${enc(id)}/concepts`, {
    path,
    content,
  });
}

// Markdown index listing for a directory in the bundle ("" = root).
export function navigateBundle(id: string, dirPath = ""): Promise<{ listing: string }> {
  const q = dirPath ? `?dirPath=${enc(dirPath)}` : "";
  return apiGet<{ listing: string }>(`${BASE}/bundles/${enc(id)}/navigate${q}`);
}

export function getBundleGraph(id: string): Promise<BundleGraph> {
  return apiGet<BundleGraph>(`${BASE}/bundles/${enc(id)}/graph`);
}

// A page that links to a concept (the "Linked from" panel). `bundleName` lets the UI resolve the
// source's space without an extra lookup; cross-space backlinks come back the same shape.
export type Backlink = {
  sourceId: string;
  title: string;
  path: string | null;
  bundleId: string;
  bundleName: string;
};

// A flat reference to one OKF page across all bundles — feeds the editor's `@`-mention Pages section.
export type BundlePageRef = {
  documentId: string;
  bundleId: string;
  bundleName: string;
  path: string;
  title: string;
};

export function getBacklinks(documentId: string): Promise<{ items: Backlink[] }> {
  return apiGet<{ items: Backlink[] }>(`${BASE}/documents/${enc(documentId)}/backlinks`);
}

// One stored revision of a concept's full OKF content (the API returns them newest-first). `content`
// is the full markdown — enough to preview read-only and to Restore (re-POST via writeConcept).
export type KnowledgeRevision = {
  id: string;
  documentId: string;
  revisionNumber: number;
  content: string;
  reason: string | null;
  createdAt: string;
};

export function listRevisions(documentId: string): Promise<{ items: KnowledgeRevision[] }> {
  return apiGet<{ items: KnowledgeRevision[] }>(`${BASE}/documents/${enc(documentId)}/revisions`);
}

export function listAllPages(): Promise<{ items: BundlePageRef[] }> {
  return apiGet<{ items: BundlePageRef[] }>(`${BASE}/pages`);
}

// A space on the Knowledge home grid: bundle metadata + its active page count and last activity
// (latest of the space's own update or any of its pages' updates).
export type SpaceOverview = KnowledgeBundle & { pageCount: number; lastActivity: string };
// A recently-edited page across all spaces, for the Knowledge home "Recently edited" list.
export type RecentPage = {
  documentId: string;
  bundleId: string;
  bundleName: string;
  path: string;
  title: string;
  updatedAt: string;
};
export type KnowledgeOverview = { spaces: SpaceOverview[]; recent: RecentPage[] };

export function getKnowledgeOverview(recentLimit = 8): Promise<KnowledgeOverview> {
  return apiGet<KnowledgeOverview>(`${BASE}/overview?recentLimit=${recentLimit}`);
}
