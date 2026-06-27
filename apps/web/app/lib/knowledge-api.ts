/*
 * Read/write client for the knowledge API (pages, spaces, search). Built on the shared
 * `apiGet`/`apiWrite`/`apiDelete` primitives in `api.ts` (cookie-first auth, CSRF echo, quoted
 * If-Match concurrency). React/Remix-free so it is unit-testable by mocking the global `fetch`.
 */
import { apiDelete, apiGet, apiWrite } from "./api";

export type IndexingStatus = "indexed" | "lexical-only" | "pending";
export type KnowledgeSource = "authored" | "resource" | "conversation";

export type KnowledgePage = {
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
  // OKF-only; present on space pages so a tag-filtered listing can link to its page route.
  spaceId?: string | null;
  path?: string | null;
  // OKF page metadata — also returned by `GET /pages/:id`, so a by-id load can render the view.
  resource?: string | null;
  createdAt: string;
  updatedAt: string;
  // Derived server-side from the page's chunks (read-only). Absent on older payloads.
  indexingStatus?: IndexingStatus;
};

export type SearchHit = {
  pageId: string;
  chunkId: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  score: number;
};

export type SearchResponse = { results: SearchHit[]; warnings: string[] };

export type PagePage = { items: KnowledgePage[]; nextCursor: string | null };

export type PageInput = {
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
};

const BASE = "/api/v1/knowledge";
const enc = encodeURIComponent;

function pageQuery(cursor: string | undefined, limit: number): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

// ── pages ─────────────────────────────────────────────────────────────────────

export function listPages(cursor?: string, limit = 50, tags?: string[]): Promise<PagePage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  if (tags && tags.length > 0) q.set("tags", tags.join(","));
  return apiGet<PagePage>(`${BASE}/pages?${q.toString()}`);
}

export function getPage(id: string): Promise<KnowledgePage> {
  return apiGet<KnowledgePage>(`${BASE}/pages/${enc(id)}`);
}

export function createPage(body: PageInput): Promise<KnowledgePage> {
  return apiWrite<KnowledgePage>("POST", `${BASE}/pages`, body);
}

// Full-replace update with optimistic concurrency; `version` becomes the quoted If-Match header.
export function updatePage(
  id: string,
  version: number,
  body: Partial<PageInput>
): Promise<KnowledgePage> {
  return apiWrite<KnowledgePage>("PUT", `${BASE}/pages/${enc(id)}`, body, version);
}

export function deletePage(id: string): Promise<void> {
  return apiDelete(`${BASE}/pages/${enc(id)}`);
}

// Semantic search is a POST that reads — it still carries the CSRF echo header via `apiWrite`.
export function searchKnowledge(query: string, limit = 10): Promise<SearchResponse> {
  return apiWrite<SearchResponse>("POST", `${BASE}/search`, { query, limit });
}

// A whole-page search hit (granularity "page"). Distinct from the chunk-level SearchHit.
export type PageSearchHit = {
  pageId: string;
  title: string;
  spaceId: string | null;
  path: string | null;
  snippet: string;
  highlightRanges: Array<[number, number]>;
  score: number;
};

export type PageSearchResponse = { results: PageSearchHit[]; warnings: string[] };

// Page-level human search (granularity "page"). A blank query returns recent pages server-side.
export function searchPages(
  query: string,
  opts: { spaceId?: string; type?: string; limit?: number } = {}
): Promise<PageSearchHit[]> {
  return apiWrite<PageSearchResponse>("POST", `${BASE}/search`, {
    query,
    granularity: "page",
    limit: opts.limit ?? 10,
    ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
    ...(opts.type ? { type: opts.type } : {}),
  }).then((r) => r.results);
}

// ── OKF spaces ───────────────────────────────────────────────────────────────

export type KnowledgeSpace = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

// A space member page. Carries the OKF-specific fields (path/resource) on top of the
// base knowledge-page shape; `content` is the full OKF markdown (frontmatter + body).
export type SpacePage = {
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
  spaceId: string | null;
  path: string | null;
  resource: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SpaceListPage = { items: KnowledgeSpace[]; nextCursor: string | null };

export type SpaceInput = {
  name: string;
  description?: string | null;
};

// A page write either creates/replaces a page, or — when the path's last segment is
// `index`/`log` — records a directory override (200, no page returned).
export type PageWriteResult = SpacePage | { override: true; path: string };

export type SpaceGraphNode = {
  id: string;
  path: string | null;
  title: string;
};
export type SpaceGraphEdge = {
  sourceId: string;
  targetId: string | null;
  targetPath: string;
  broken: boolean;
  /** Set when the edge points into another space (cross-space); null for same-space edges. */
  targetSpaceName: string | null;
  /** The resolved id of that other space, when it exists; null while unresolved. */
  targetSpaceId: string | null;
};
export type SpaceGraph = {
  nodes: SpaceGraphNode[];
  edges: SpaceGraphEdge[];
  truncated: boolean;
};

export function listSpaces(cursor?: string, limit = 50): Promise<SpaceListPage> {
  return apiGet<SpaceListPage>(`${BASE}/spaces?${pageQuery(cursor, limit)}`);
}

export function getSpace(id: string): Promise<KnowledgeSpace> {
  return apiGet<KnowledgeSpace>(`${BASE}/spaces/${enc(id)}`);
}

export function createSpace(body: SpaceInput): Promise<KnowledgeSpace> {
  return apiWrite<KnowledgeSpace>("POST", `${BASE}/spaces`, body);
}

export function updateSpace(id: string, body: Partial<SpaceInput>): Promise<KnowledgeSpace> {
  return apiWrite<KnowledgeSpace>("PUT", `${BASE}/spaces/${enc(id)}`, body);
}

export function deleteSpace(id: string): Promise<void> {
  return apiDelete(`${BASE}/spaces/${enc(id)}`);
}

export function listSpacePages(id: string): Promise<{ items: SpacePage[] }> {
  return apiGet<{ items: SpacePage[] }>(`${BASE}/spaces/${enc(id)}/pages`);
}

// Author/replace a page (or record a directory override). The server parses/validates the OKF
// `content`; a 400 carries the validation message (surfaced by the form).
export function writePage(id: string, path: string, content: string): Promise<PageWriteResult> {
  return apiWrite<PageWriteResult>("POST", `${BASE}/spaces/${enc(id)}/pages`, {
    path,
    content,
  });
}

// Markdown index listing for a directory in the space ("" = root).
export function navigateSpace(id: string, dirPath = ""): Promise<{ listing: string }> {
  const q = dirPath ? `?dirPath=${enc(dirPath)}` : "";
  return apiGet<{ listing: string }>(`${BASE}/spaces/${enc(id)}/navigate${q}`);
}

export function getSpaceGraph(id: string): Promise<SpaceGraph> {
  return apiGet<SpaceGraph>(`${BASE}/spaces/${enc(id)}/graph`);
}

// A page that links to a page (the "Linked from" panel). `spaceName` lets the UI resolve the
// source's space without an extra lookup; cross-space backlinks come back the same shape.
export type Backlink = {
  sourceId: string;
  title: string;
  path: string | null;
  spaceId: string;
  spaceName: string;
};

// A flat reference to one OKF page across all spaces — feeds the editor's `@`-mention Pages section.
export type SpacePageRef = {
  pageId: string;
  spaceId: string;
  spaceName: string;
  path: string;
  title: string;
};

export function getBacklinks(pageId: string): Promise<{ items: Backlink[] }> {
  return apiGet<{ items: Backlink[] }>(`${BASE}/pages/${enc(pageId)}/backlinks`);
}

// One stored revision of a page's full OKF content (the API returns them newest-first). `content`
// is the full markdown — enough to preview read-only and to Restore (re-POST via writePage).
export type KnowledgeRevision = {
  id: string;
  pageId: string;
  revisionNumber: number;
  content: string;
  reason: string | null;
  createdAt: string;
};

export function listRevisions(pageId: string): Promise<{ items: KnowledgeRevision[] }> {
  return apiGet<{ items: KnowledgeRevision[] }>(`${BASE}/pages/${enc(pageId)}/revisions`);
}

export function listAllPages(): Promise<{ items: SpacePageRef[] }> {
  return apiGet<{ items: SpacePageRef[] }>(`${BASE}/pages/mentions`);
}

// A space on the Knowledge home grid: space metadata + its active page count and last activity
// (latest of the space's own update or any of its pages' updates).
export type SpaceOverview = KnowledgeSpace & { pageCount: number; lastActivity: string };
// A recently-edited page across all spaces, for the Knowledge home "Recently edited" list.
export type RecentPage = {
  pageId: string;
  spaceId: string;
  spaceName: string;
  path: string;
  title: string;
  updatedAt: string;
};
export type KnowledgeOverview = { spaces: SpaceOverview[]; recent: RecentPage[] };

export function getKnowledgeOverview(recentLimit = 8): Promise<KnowledgeOverview> {
  return apiGet<KnowledgeOverview>(`${BASE}/overview?recentLimit=${recentLimit}`);
}
