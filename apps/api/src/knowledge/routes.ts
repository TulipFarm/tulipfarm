import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../activity/service";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { parsePaginationQuery } from "../pagination";
import type { PageHit, PageRetrievalService } from "./page-search-adapter";
import { type KnowledgeService, SpaceNameTakenError } from "./service";
import type {
  IndexingStatus,
  KnowledgePage,
  KnowledgeRevision,
  KnowledgeSource,
  KnowledgeSpace,
  SearchFilters,
  SearchHit,
} from "./types";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

function parseIfMatch(req: FastifyRequest): number | null {
  const raw = req.headers["if-match"];
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw.replace(/^"(.*)"$/, "$1"), 10);
  return Number.isNaN(n) ? null : n;
}

function toApiPage(p: KnowledgePage, status?: IndexingStatus): Record<string, unknown> {
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

function toApiRevision(r: KnowledgeRevision): Record<string, unknown> {
  return {
    id: r._id,
    pageId: r.pageId,
    revisionNumber: r.revisionNumber,
    content: r.content,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

function toApiHit(h: SearchHit): Record<string, unknown> {
  return {
    pageId: h.pageId,
    chunkId: h.chunkId,
    title: h.title,
    content: h.content,
    source: h.source,
    score: h.score,
  };
}

function pageHitToApi(h: PageHit): Record<string, unknown> {
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

function filtersFromQuery(q: Record<string, unknown>): SearchFilters {
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

const PageDocSchema = {
  type: "object",
  additionalProperties: true,
  properties: { id: { type: "string" }, version: { type: "number" } },
  required: ["id", "version"],
} as const;

const PaginatedSchema = (item: object) =>
  ({
    type: "object",
    properties: {
      items: { type: "array", items: item },
      nextCursor: { type: "string", nullable: true },
    },
    required: ["items", "nextCursor"],
  }) as const;

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  service: KnowledgeService,
  requireAuth: PreHandler,
  // Optional: only the page-search branch needs it. When absent, page-mode requests fall back to
  // chunk search so the knowledge routes never disappear just because the spine wasn't wired.
  retrieval?: PageRetrievalService,
  // Optional: record page/space creation in the activity feed.
  activity?: ActivityService
): void {
  const sec: Array<Record<string, string[]>> = [{ sessionCookie: [] }, { bearerToken: [] }];
  const tags = ["knowledge"];

  // ── pages ──────────────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/knowledge/pages",
    {
      preHandler: requireAuth,
      schema: {
        description: "Create an authored knowledge page (markdown).",
        tags,
        security: sec,
        body: {
          type: "object",
          required: ["title", "content"],
          properties: {
            title: { type: "string", minLength: 1 },
            content: { type: "string" },
            domain: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            alwaysLoadForAgents: { type: "boolean" },
          },
        },
        response: { 201: PageDocSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        title: string;
        content: string;
        domain?: string | null;
        tags?: string[];
        alwaysLoadForAgents?: boolean;
      };
      const page = await service.createPage(b);
      await activity?.record({
        category: "knowledge",
        action: "page.created",
        actorId: (req.user as UserDoc | undefined)?._id,
        targetType: "page",
        targetId: page._id,
        summary: `Created knowledge page "${page.title}"`,
        metadata: { title: page.title },
      });
      const status = await service.getIndexingStatus(page._id);
      return reply.code(201).send(toApiPage(page, status));
    }
  );

  app.get(
    "/api/v1/knowledge/pages",
    {
      preHandler: requireAuth,
      schema: {
        description: "List knowledge pages (cursor paginated; filter by domain/source/tags).",
        tags,
        security: sec,
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "number" },
            domain: { type: "string" },
            source: { type: "string" },
            tags: { type: "string" },
          },
        },
        response: { 200: PaginatedSchema(PageDocSchema), 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const { limit, after } = parsePaginationQuery(q);
      const page = await service.listPages({ limit, after, ...filtersFromQuery(q) });
      const statuses = await service.getIndexingStatuses(page.items.map((d) => d._id));
      return reply.send({
        items: page.items.map((d) => toApiPage(d, statuses.get(d._id) ?? "pending")),
        nextCursor: page.nextCursor,
      });
    }
  );

  // The @-mention Pages picker — a flat list of every OKF page. Static `/pages/mentions` is routed
  // ahead of the param `/pages/:id`, so it never collides with the page-by-id lookup below.
  app.get(
    "/api/v1/knowledge/pages/mentions",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Flat list of every OKF page across all spaces (for the @-mention Pages picker).",
        tags,
        security: sec,
        response: {
          200: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const items = await service.listAllPages();
      return reply.send({ items });
    }
  );

  app.get(
    "/api/v1/knowledge/pages/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get one knowledge page.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 200: PageDocSchema, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const page = await service.getPage(id);
      if (!page?.active) return reply.code(404).send({ error: "not found" });
      const status = await service.getIndexingStatus(page._id);
      return reply.send(toApiPage(page, status));
    }
  );

  app.put(
    "/api/v1/knowledge/pages/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Update a page. Requires If-Match with the current version.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: { type: "object", additionalProperties: true },
        response: {
          200: PageDocSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });
      const outcome = await service.updatePage(id, req.body as Record<string, unknown>, ifMatch);
      if (!outcome.ok) {
        return outcome.reason === "not_found"
          ? reply.code(404).send({ error: "not found" })
          : reply.code(409).send({ error: "version conflict" });
      }
      const status = await service.getIndexingStatus(id);
      return reply.send(toApiPage(outcome.value, status));
    }
  );

  app.delete(
    "/api/v1/knowledge/pages/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Soft-delete a knowledge page.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 204: { type: "null" }, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await service.deletePage(id);
      return ok ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
    }
  );

  // ── revisions ────────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/knowledge/pages/:id/revisions",
    {
      preHandler: requireAuth,
      schema: {
        description: "Append a manual revision snapshot.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["content"],
          properties: { content: { type: "string" }, reason: { type: "string", nullable: true } },
        },
        response: {
          201: { type: "object", properties: { revisionNumber: { type: "number" } } },
          404: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { content: string; reason?: string | null };
      const n = await service.createRevision(id, b.content, b.content.trim(), b.reason ?? null);
      if (n === null) return reply.code(404).send({ error: "not found" });
      return reply.code(201).send({ revisionNumber: n });
    }
  );

  app.get(
    "/api/v1/knowledge/pages/:id/revisions",
    {
      preHandler: requireAuth,
      schema: {
        description: "List a page's revisions (newest first).",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: {
          200: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const revs = await service.listRevisions(id);
      return reply.send({ items: revs.map(toApiRevision) });
    }
  );

  // ── search ───────────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/knowledge/search",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Search knowledge. granularity 'chunk' (default) = vector-primary, lexical fallback; " +
          "'page' = lexical page-level spine (title+body+recency, trgm typo recall). Blank query in " +
          "page mode returns recent pages.",
        tags,
        security: sec,
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            granularity: { type: "string", enum: ["chunk", "page"] },
            domain: { type: "string" },
            source: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            spaceId: { type: "string" },
            type: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { results: { type: "array" }, warnings: { type: "array" } },
            required: ["results", "warnings"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { query: string; limit?: number; granularity?: string } & Record<
        string,
        unknown
      >;
      const limit = Math.min(Math.max(b.limit ?? 10, 1), 50);
      if (b.granularity === "page" && retrieval) {
        const filters = filtersFromQuery(b);
        const hits =
          b.query.trim() === ""
            ? await retrieval.recentPages(limit, filters)
            : await retrieval.searchPages({ query: b.query, filters, limit });
        return reply.send({ results: hits.map(pageHitToApi), warnings: [] });
      }
      // Chunk mode has no zero-query state — a blank query short-circuits (the schema no longer enforces
      // a min length, since page mode needs blanks for its recent-pages fallback).
      if (b.query.trim() === "") {
        return reply.send({ results: [], warnings: [] });
      }
      const res = await service.search(b.query, filtersFromQuery(b), limit);
      return reply.send({ results: res.results.map(toApiHit), warnings: res.warnings });
    }
  );

  // ── OKF spaces ───────────────────────────────────────────────────────────────

  const SpaceSchema = {
    type: "object",
    additionalProperties: true,
    properties: { id: { type: "string" } },
    required: ["id"],
  } as const;
  const toApiSpace = (s: KnowledgeSpace): Record<string, unknown> => ({
    id: s._id,
    name: s.name,
    description: s.description,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  });

  app.post(
    "/api/v1/knowledge/spaces",
    {
      preHandler: requireAuth,
      schema: {
        description: "Create an OKF knowledge space.",
        tags,
        security: sec,
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string", nullable: true },
          },
        },
        response: { 201: SpaceSchema, 400: ErrorSchema, 409: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const res = await service.createSpace(
        req.body as { name: string; description?: string | null }
      );
      if (!res.ok) {
        return reply.code(res.reason === "name_taken" ? 409 : 400).send({ error: res.reason });
      }
      await activity?.record({
        category: "knowledge",
        action: "space.created",
        actorId: (req.user as UserDoc | undefined)?._id,
        targetType: "space",
        targetId: res.space._id,
        summary: `Created knowledge space "${res.space.name}"`,
        metadata: { name: res.space.name },
      });
      return reply.code(201).send(toApiSpace(res.space));
    }
  );

  app.get(
    "/api/v1/knowledge/spaces",
    {
      preHandler: requireAuth,
      schema: {
        description: "List OKF spaces (cursor paginated).",
        tags,
        security: sec,
        querystring: {
          type: "object",
          properties: { cursor: { type: "string" }, limit: { type: "number" } },
        },
        response: { 200: PaginatedSchema(SpaceSchema), 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { limit, after } = parsePaginationQuery(req.query as Record<string, unknown>);
      const page = await service.listSpaces({ limit, after });
      return reply.send({ items: page.items.map(toApiSpace), nextCursor: page.nextCursor });
    }
  );

  app.get(
    "/api/v1/knowledge/spaces/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get one OKF space.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 200: SpaceSchema, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const s = await service.getSpace(id);
      if (!s) return reply.code(404).send({ error: "not found" });
      return reply.send(toApiSpace(s));
    }
  );

  app.put(
    "/api/v1/knowledge/spaces/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Update an OKF space's metadata.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string", nullable: true },
          },
        },
        response: { 200: SpaceSchema, 404: ErrorSchema, 409: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const s = await service.updateSpace(
          id,
          req.body as { name?: string; description?: string | null }
        );
        if (!s) return reply.code(404).send({ error: "not found" });
        return reply.send(toApiSpace(s));
      } catch (err) {
        // Rename collided with an existing space name (pre-check, or the UNIQUE index mapped to this
        // error inside updateSpace). Other errors from the rename rewrite propagate as 500s.
        if (err instanceof SpaceNameTakenError) {
          return reply.code(409).send({ error: "space name already in use" });
        }
        throw err;
      }
    }
  );

  app.delete(
    "/api/v1/knowledge/spaces/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Delete an OKF space (cascades its pages, links, overrides).",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 204: { type: "null" }, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await service.deleteSpace(id);
      return ok ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
    }
  );

  app.get(
    "/api/v1/knowledge/spaces/:id/pages",
    {
      preHandler: requireAuth,
      schema: {
        description: "List the pages in a space (with path + OKF type).",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: {
          200: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
          404: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await service.getSpace(id))) return reply.code(404).send({ error: "not found" });
      const pages = await service.listSpacePages(id);
      return reply.send({ items: pages.map((p) => toApiPage(p)) });
    }
  );

  app.post(
    "/api/v1/knowledge/spaces/:id/pages",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Author or update an OKF page (full markdown). A reserved index/log path sets a directory override.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", minLength: 1 },
            content: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
          201: PageDocSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          401: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { path: string; content: string };
      const res = await service.writePage({ spaceId: id, path: b.path, content: b.content });
      if (!res.ok) {
        if (res.reason === "space_not_found") return reply.code(404).send({ error: "not found" });
        if (res.reason === "okf_unavailable") return reply.code(503).send({ error: res.reason });
        return reply.code(400).send({ error: res.reason });
      }
      if ("override" in res) return reply.code(200).send({ override: true, path: b.path });
      return reply.code(201).send(toApiPage(res.page));
    }
  );

  app.get(
    "/api/v1/knowledge/spaces/:id/navigate",
    {
      preHandler: requireAuth,
      schema: {
        description: "Progressive-disclosure index listing for a directory (dirPath, '' = root).",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        querystring: { type: "object", properties: { dirPath: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: { listing: { type: "string" } },
            required: ["listing"],
          },
          404: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { dirPath } = req.query as { dirPath?: string };
      const listing = await service.navigateSpace(id, dirPath ?? "");
      if (listing === null) return reply.code(404).send({ error: "not found" });
      return reply.send({ listing });
    }
  );

  app.get(
    "/api/v1/knowledge/spaces/:id/graph",
    {
      preHandler: requireAuth,
      schema: {
        description: "Node + edge list for a space's cross-link graph (capped).",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: {
          200: {
            type: "object",
            properties: {
              nodes: { type: "array" },
              edges: { type: "array" },
              truncated: { type: "boolean" },
            },
            required: ["nodes", "edges", "truncated"],
          },
          404: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const graph = await service.getSpaceGraph(id);
      if (!graph) return reply.code(404).send({ error: "not found" });
      return reply.send(graph);
    }
  );

  app.get(
    "/api/v1/knowledge/pages/:id/backlinks",
    {
      preHandler: requireAuth,
      schema: {
        description: "Pages that link to a page (same- or cross-space) — the 'Linked from' panel.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: {
          200: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
          404: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const items = await service.getBacklinks(id);
      if (items === null) return reply.code(404).send({ error: "not found" });
      return reply.send({ items });
    }
  );

  app.get(
    "/api/v1/knowledge/overview",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Knowledge home overview: every space with page count + last activity, and recently-edited pages.",
        tags,
        security: sec,
        querystring: {
          type: "object",
          properties: { recentLimit: { type: "number" } },
        },
        response: {
          200: {
            type: "object",
            properties: { spaces: { type: "array" }, recent: { type: "array" } },
            required: ["spaces", "recent"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const raw = Number((req.query as { recentLimit?: number }).recentLimit);
      const recentLimit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 20) : 8;
      const { spaces, recent } = await service.getKnowledgeOverview(recentLimit);
      return reply.send({
        spaces: spaces.map((s) => ({
          ...toApiSpace(s.space),
          pageCount: s.pageCount,
          lastActivity: s.lastActivity.toISOString(),
        })),
        recent: recent.map((p) => ({
          pageId: p.pageId,
          spaceId: p.spaceId,
          spaceName: p.spaceName,
          path: p.path,
          title: p.title,
          updatedAt: p.updatedAt.toISOString(),
        })),
      });
    }
  );

  // ── admin: reindex / backfill / index-status ─────────────────────────────────────
  // Operational endpoints. Authenticated AND admin-only (mirrors secrets routes): a non-admin gets
  // 403 even though requireAuth passed.
  const isAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if ((req.user as UserDoc).role !== "admin") {
      reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  };

  app.post(
    "/api/v1/knowledge/reindex",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Re-index knowledge (admin). Body { pageId } re-indexes one page, { spaceId } a whole space, neither a full re-index.",
        tags,
        security: sec,
        body: {
          type: "object",
          properties: { pageId: { type: "string" }, spaceId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: { reindexed: { type: "number" } },
            required: ["reindexed"],
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!isAdmin(req, reply)) return;
      const b = (req.body ?? {}) as { pageId?: string; spaceId?: string };
      const reindexed = await service.reindexTargeted({ pageId: b.pageId, spaceId: b.spaceId });
      return reply.send({ reindexed });
    }
  );

  app.post(
    "/api/v1/knowledge/backfill",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Backfill embeddings (admin): re-index every active page with an unembedded or stale-model chunk. No-op without a provider.",
        tags,
        security: sec,
        response: {
          200: {
            type: "object",
            properties: { reindexed: { type: "number" } },
            required: ["reindexed"],
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!isAdmin(req, reply)) return;
      const reindexed = await service.backfillMissing();
      return reply.send({ reindexed });
    }
  );

  app.get(
    "/api/v1/knowledge/index-status",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Index health (admin): active pages, chunk embed/lexical counts, max index lag, and pg-boss queue stats.",
        tags,
        security: sec,
        response: {
          200: { type: "object", additionalProperties: true },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!isAdmin(req, reply)) return;
      const status = await service.indexStatus();
      return reply.send({
        activePages: status.activePages,
        chunks: status.chunks,
        indexLagSeconds: status.indexLagSeconds,
        queue: status.queue
          ? {
              pending: status.queue.pending,
              lastError: status.queue.lastError
                ? {
                    message: status.queue.lastError.message,
                    failedAt: status.queue.lastError.failedAt.toISOString(),
                  }
                : null,
            }
          : null,
      });
    }
  );
}
