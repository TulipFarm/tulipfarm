import type {
  IndexingStatus,
  KnowledgePage,
  KnowledgeRevision,
  KnowledgeSource,
  PageHit,
  SearchFilters,
  SearchHit,
} from "@tulipfarm/knowledge";
import type { FastifyRequest } from "fastify";

export function parseIfMatch(req: FastifyRequest): number | null {
  const raw = req.headers["if-match"];
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw.replace(/^"(.*)"$/, "$1"), 10);
  return Number.isNaN(n) ? null : n;
}

export function toApiPage(p: KnowledgePage, status?: IndexingStatus): Record<string, unknown> {
  return {
    id: p._id,
    title: p.title,
    content: p.content,
    source: p.source,
    sourceId: p.sourceId,
    domain: p.domain,
    tags: p.tags,
    active: p.active,
    alwaysLoadForAgents: p.alwaysLoadForAgents,
    version: p.version,
    spaceId: p.spaceId ?? null,
    path: p.path ?? null,
    resource: p.resource ?? null,
    frontmatterExtra: p.frontmatterExtra ?? {},
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    ...(status !== undefined ? { indexingStatus: status } : {}),
  };
}

export function toApiRevision(r: KnowledgeRevision): Record<string, unknown> {
  return {
    id: r._id,
    pageId: r.pageId,
    revisionNumber: r.revisionNumber,
    content: r.content,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toApiHit(h: SearchHit): Record<string, unknown> {
  return {
    pageId: h.pageId,
    chunkId: h.chunkId,
    title: h.title,
    content: h.content,
    source: h.source,
    score: h.score,
  };
}

export function pageHitToApi(h: PageHit): Record<string, unknown> {
  return {
    pageId: h.pageId,
    title: h.title,
    spaceId: h.spaceId,
    path: h.path,
    snippet: h.snippet,
    highlightRanges: h.highlightRanges,
    score: h.score,
  };
}

export function filtersFromQuery(q: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {};
  if (typeof q.domain === "string") filters.domain = q.domain;
  if (typeof q.source === "string") filters.source = q.source as KnowledgeSource;
  if (typeof q.tags === "string") filters.tags = q.tags.split(",").filter(Boolean);
  else if (Array.isArray(q.tags))
    filters.tags = q.tags.filter((t): t is string => typeof t === "string");
  if (typeof q.spaceId === "string") filters.spaceId = q.spaceId;
  if (typeof q.type === "string") filters.type = q.type;
  return filters;
}
