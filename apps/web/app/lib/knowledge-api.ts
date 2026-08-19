/*
 * Read/write client for the knowledge API (pages, spaces, search). Built on the shared
 * `apiGet`/`apiWrite`/`apiDelete` primitives in `api.ts` (cookie-first auth, CSRF echo, quoted
 * If-Match concurrency).
 */
import { apiDelete, apiGet, apiWrite } from "./api";

export type IndexingStatus = "indexed" | "lexical-only" | "pending";
export type KnowledgeSource = "authored" | "resource" | "conversation";

export type KnowledgePage = {
  visibility?: "business" | "own" | "inherited";
  authorKind?: "user" | "agent" | null;
  authorId?: string | null;
  /** The author's name, resolved by the API. Null when the author is unknown. */
  authorLabel?: string | null;
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
  authorKind?: "user" | "agent" | null;
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
  visibility?: "business" | "own" | "inherited";
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
  authorKind?: "user" | "agent" | null;
  authorId?: string | null;
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

/**
 * The Business-wide graph. Narrower than {@link SpaceGraph} on purpose: every edge here has two
 * drawn endpoints, so there is no broken/cross-space stub to render and nothing dangling to infer
 * a withheld Page from.
 */
export type KnowledgeGraph = {
  nodes: Array<{ id: string; path: string; title: string; spaceId: string }>;
  edges: Array<{ sourceId: string; targetId: string }>;
  spaces: Array<{ id: string; name: string }>;
  truncated: boolean;
};

export function getKnowledgeGraph(): Promise<KnowledgeGraph> {
  return apiGet<KnowledgeGraph>(`${BASE}/graph`);
}

export type Backlink = {
  sourceId: string;
  title: string;
  path: string | null;
  spaceId: string;
  spaceName: string;
};

export type SpacePageRef = {
  visibility?: "business" | "own" | "inherited";
  pageId: string;
  spaceId: string;
  spaceName: string;
  path: string;
  title: string;
  /** "agent" when an Agent wrote it. Null means unknown, never "a person wrote it". */
  authorKind?: "user" | "agent" | null;
  authorId?: string | null;
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
  visibility?: "business" | "own" | "inherited";
  authorKind?: "user" | "agent" | null;
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

export type SubjectRef = { kind: "user" | "group" | "role"; id: string };
export type DirectorySubject = SubjectRef & { label: string };
export type SubjectDirectory = {
  users: DirectorySubject[];
  teams: DirectorySubject[];
  roles: DirectorySubject[];
};

export type NamedReader = {
  kind: string;
  id: string;
  label: string;
  /** The Team or Role that grants them access, or null when they were named directly. */
  via: SubjectRef | null;
};

/**
 * Where a Page's readership comes from.
 *
 * `scope` separates the three cases a reader has to tell apart before they act: `business` (anyone
 * here), `own` (this Page carries its own restriction), `inherited` (an ancestor imposes it, and
 * the author cannot loosen it here).
 */
export type PageVisibility = {
  restricted: boolean;
  scope: "business" | "own" | "inherited";
  own: DirectorySubject[];
  inheritedFrom: { pageId: string | null; path: string; title: string } | null;
  readers: NamedReader[];
};

export type MoveEffect = "widens" | "narrows" | "mixed" | "unchanged";

export type PageMoveDescendant = { pageId: string; path: string; effect: MoveEffect };

export type PageMovePreview = {
  effect: MoveEffect;
  before: SubjectRef[];
  after: SubjectRef[];
  gained: SubjectRef[];
  lost: SubjectRef[];
  /** Null when the Page carries no restriction of its own — there is nothing to survive. */
  ownRestrictionSurvives: boolean | null;
  descendants: PageMoveDescendant[];
};

export function previewPageMove(
  pageId: string,
  dest: { spaceId?: string; path?: string }
): Promise<PageMovePreview> {
  return apiWrite<PageMovePreview>("POST", `${BASE}/pages/${enc(pageId)}/move/preview`, dest);
}

export function movePage(
  pageId: string,
  dest: { spaceId?: string; path?: string }
): Promise<PageMovePreview> {
  return apiWrite<PageMovePreview>("POST", `${BASE}/pages/${enc(pageId)}/move`, dest);
}

export function listSubjects(): Promise<SubjectDirectory> {
  return apiGet<SubjectDirectory>(`${BASE}/subjects`);
}

export function getPageVisibility(pageId: string): Promise<PageVisibility> {
  return apiGet<PageVisibility>(`${BASE}/pages/${enc(pageId)}/visibility`);
}

export function restrictPage(pageId: string, subjects: SubjectRef[]): Promise<PageVisibility> {
  return apiWrite<PageVisibility>("PUT", `${BASE}/pages/${enc(pageId)}/restriction`, { subjects });
}

export function unrestrictPage(pageId: string): Promise<void> {
  return apiDelete(`${BASE}/pages/${enc(pageId)}/restriction`);
}

export type SpaceRestriction = { restricted: boolean; subjects: SubjectRef[] };

export function getSpaceRestriction(spaceId: string): Promise<SpaceRestriction> {
  return apiGet<SpaceRestriction>(`${BASE}/spaces/${enc(spaceId)}/restriction`);
}

export function restrictSpace(spaceId: string, subjects: SubjectRef[]): Promise<unknown> {
  return apiWrite("PUT", `${BASE}/spaces/${enc(spaceId)}/restriction`, { subjects });
}

export function unrestrictSpace(spaceId: string): Promise<void> {
  return apiDelete(`${BASE}/spaces/${enc(spaceId)}/restriction`);
}
