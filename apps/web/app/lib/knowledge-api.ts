/*
 * Read/write client for the knowledge API (pages, spaces, search). Built on the shared
 * `apiGet`/`apiWrite`/`apiDelete` primitives in `api.ts` (cookie-first auth, CSRF echo, quoted
 * If-Match concurrency).
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
  spaceId?: string | null;
  path?: string | null;
  resource?: string | null;
  createdAt: string;
  updatedAt: string;
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

export function searchKnowledge(query: string, limit = 10): Promise<SearchResponse> {
  return apiWrite<SearchResponse>("POST", `${BASE}/search`, { query, limit });
}

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

export type KnowledgeSpace = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

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

export function writePage(id: string, path: string, content: string): Promise<PageWriteResult> {
  return apiWrite<PageWriteResult>("POST", `${BASE}/spaces/${enc(id)}/pages`, {
    path,
    content,
  });
}

export function navigateSpace(id: string, dirPath = ""): Promise<{ listing: string }> {
  const q = dirPath ? `?dirPath=${enc(dirPath)}` : "";
  return apiGet<{ listing: string }>(`${BASE}/spaces/${enc(id)}/navigate${q}`);
}

export function getSpaceGraph(id: string): Promise<SpaceGraph> {
  return apiGet<SpaceGraph>(`${BASE}/spaces/${enc(id)}/graph`);
}

export type Backlink = {
  sourceId: string;
  title: string;
  path: string | null;
  spaceId: string;
  spaceName: string;
};

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

export type SpaceOverview = KnowledgeSpace & { pageCount: number; lastActivity: string };
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
