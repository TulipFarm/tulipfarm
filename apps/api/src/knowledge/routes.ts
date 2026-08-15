import type { KnowledgeSpace, PageRetrievalService } from "@tulipfarm/knowledge";
import { type KnowledgeService, SpaceNameTakenError } from "@tulipfarm/knowledge";
import { parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../activity/service";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { RequireAuthorization } from "../authz/route-gate";
import {
  filtersFromQuery,
  pageHitToApi,
  parseIfMatch,
  toApiHit,
  toApiPage,
  toApiRevision,
} from "./mappers";
import {
  EntityIdParamsSchema,
  IndexStatusResponseSchema,
  NoContentSchema,
  OverviewQuerySchema,
  OverviewResponseSchema,
  PageBacklinksResponseSchema,
  PageCreateBodySchema,
  PageListQuerySchema,
  PageListResponseSchema,
  PageMentionsResponseSchema,
  PageResponseSchema,
  PageRevisionCreateBodySchema,
  PageRevisionCreatedResponseSchema,
  PageRevisionListResponseSchema,
  PageUpdateBodySchema,
  ReindexBodySchema,
  ReindexedCountResponseSchema,
  SearchBodySchema,
  SearchResponseSchema,
  SpaceCreateBodySchema,
  SpaceGraphResponseSchema,
  SpaceListQuerySchema,
  SpaceListResponseSchema,
  SpaceNavigateQuerySchema,
  SpaceNavigateResponseSchema,
  SpacePageListResponseSchema,
  SpacePageWriteBodySchema,
  SpacePageWriteResultSchema,
  SpaceResponseSchema,
  SpaceUpdateBodySchema,
} from "./schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

type SchemaOptions = {
  description: string;
  body?: object;
  params?: object;
  querystring?: object;
  response: Record<number, object>;
};

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  service: KnowledgeService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  retrieval?: PageRetrievalService,
  activity?: ActivityService
): void {
  const sec: Array<Record<string, string[]>> = [{ sessionCookie: [] }, { bearerToken: [] }];
  const tags = ["knowledge"];

  const route = ({ description, ...schema }: SchemaOptions) => ({
    preHandler: requireAuth,
    schema: { description, tags, security: sec, ...schema },
  });
  app.post(
    "/api/v1/knowledge/pages",
    route({
      description: "Create an authored knowledge page (markdown).",
      body: PageCreateBodySchema,
      response: { 201: PageResponseSchema, 400: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const page = await service.createPage(
        req.body as {
          title: string;
          content: string;
          domain?: string | null;
          tags?: string[];
          alwaysLoadForAgents?: boolean;
        }
      );
      await activity?.record({
        category: "knowledge",
        action: "page.created",
        actorId: (req.user as UserDoc | undefined)?._id,
        targetType: "page",
        targetId: page._id,
        summary: `Created knowledge page "${page.title}"`,
        metadata: { title: page.title },
      });
      return reply.code(201).send(toApiPage(page, await service.getIndexingStatus(page._id)));
    }
  );
  app.get(
    "/api/v1/knowledge/pages",
    route({
      description: "List knowledge pages (cursor paginated; filter by domain/source/tags).",
      querystring: PageListQuerySchema,
      response: { 200: PageListResponseSchema, 401: ErrorSchema },
    }),
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
  app.get(
    "/api/v1/knowledge/pages/mentions",
    route({
      description:
        "Flat list of every OKF page across all spaces (for the @-mention Pages picker).",
      response: { 200: PageMentionsResponseSchema, 401: ErrorSchema },
    }),
    async (_req, reply) => {
      const items = await service.listAllPages();
      return reply.send({ items });
    }
  );
  app.get(
    "/api/v1/knowledge/pages/:id",
    route({
      description: "Get one knowledge page.",
      params: EntityIdParamsSchema,
      response: { 200: PageResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const page = await service.getPage((req.params as { id: string }).id);
      if (!page?.active) return reply.code(404).send({ error: "not found" });
      return reply.send(toApiPage(page, await service.getIndexingStatus(page._id)));
    }
  );
  app.put(
    "/api/v1/knowledge/pages/:id",
    route({
      description: "Update a page. Requires If-Match with the current version.",
      params: EntityIdParamsSchema,
      body: PageUpdateBodySchema,
      response: {
        200: PageResponseSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        401: ErrorSchema,
      },
    }),
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
      return reply.send(toApiPage(outcome.value, await service.getIndexingStatus(id)));
    }
  );
  app.delete(
    "/api/v1/knowledge/pages/:id",
    route({
      description: "Soft-delete a knowledge page.",
      params: EntityIdParamsSchema,
      response: { 204: NoContentSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      return (await service.deletePage((req.params as { id: string }).id))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "not found" });
    }
  );
  app.post(
    "/api/v1/knowledge/pages/:id/revisions",
    route({
      description: "Append a manual revision snapshot.",
      params: EntityIdParamsSchema,
      body: PageRevisionCreateBodySchema,
      response: {
        201: PageRevisionCreatedResponseSchema,
        404: ErrorSchema,
        401: ErrorSchema,
      },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { content: string; reason?: string | null };
      const n = await service.createRevision(id, b.content, b.content.trim(), b.reason ?? null);
      return n === null
        ? reply.code(404).send({ error: "not found" })
        : reply.code(201).send({ revisionNumber: n });
    }
  );
  app.get(
    "/api/v1/knowledge/pages/:id/revisions",
    route({
      description: "List a page's revisions (newest first).",
      params: EntityIdParamsSchema,
      response: { 200: PageRevisionListResponseSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const revs = await service.listRevisions((req.params as { id: string }).id);
      return reply.send({ items: revs.map(toApiRevision) });
    }
  );
  app.post(
    "/api/v1/knowledge/search",
    route({
      description:
        "Search knowledge. granularity 'chunk' (default) = vector-primary, lexical fallback; " +
        "'page' = lexical page-level spine (title+body+recency, trgm typo recall). Blank query in " +
        "page mode returns recent pages.",
      body: SearchBodySchema,
      response: { 200: SearchResponseSchema, 400: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const b = req.body as Record<string, unknown> & {
        query: string;
        limit?: number;
        granularity?: string;
      };
      const limit = Math.min(Math.max(b.limit ?? 10, 1), 50);
      if (b.granularity === "page" && retrieval) {
        const filters = filtersFromQuery(b);
        const hits =
          b.query.trim() === ""
            ? await retrieval.recentPages(limit, filters)
            : await retrieval.searchPages({ query: b.query, filters, limit });
        return reply.send({ results: hits.map(pageHitToApi), warnings: [] });
      }
      if (b.query.trim() === "") {
        return reply.send({ results: [], warnings: [] });
      }
      const res = await service.search(b.query, filtersFromQuery(b), limit);
      return reply.send({ results: res.results.map(toApiHit), warnings: res.warnings });
    }
  );

  const toApiSpace = (s: KnowledgeSpace): Record<string, unknown> => ({
    id: s._id,
    name: s.name,
    description: s.description,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  });
  app.post(
    "/api/v1/knowledge/spaces",
    route({
      description: "Create an OKF knowledge space.",
      body: SpaceCreateBodySchema,
      response: {
        201: SpaceResponseSchema,
        400: ErrorSchema,
        409: ErrorSchema,
        401: ErrorSchema,
      },
    }),
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
    route({
      description: "List OKF spaces (cursor paginated).",
      querystring: SpaceListQuerySchema,
      response: { 200: SpaceListResponseSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { limit, after } = parsePaginationQuery(req.query as Record<string, unknown>);
      const page = await service.listSpaces({ limit, after });
      return reply.send({ items: page.items.map(toApiSpace), nextCursor: page.nextCursor });
    }
  );
  app.get(
    "/api/v1/knowledge/spaces/:id",
    route({
      description: "Get one OKF space.",
      params: EntityIdParamsSchema,
      response: { 200: SpaceResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const s = await service.getSpace((req.params as { id: string }).id);
      if (!s) return reply.code(404).send({ error: "not found" });
      return reply.send(toApiSpace(s));
    }
  );
  app.put(
    "/api/v1/knowledge/spaces/:id",
    route({
      description: "Update an OKF space's metadata.",
      params: EntityIdParamsSchema,
      body: SpaceUpdateBodySchema,
      response: {
        200: SpaceResponseSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        401: ErrorSchema,
      },
    }),
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
        if (err instanceof SpaceNameTakenError) {
          return reply.code(409).send({ error: "space name already in use" });
        }
        throw err;
      }
    }
  );
  app.delete(
    "/api/v1/knowledge/spaces/:id",
    route({
      description: "Delete an OKF space (cascades its pages, links, overrides).",
      params: EntityIdParamsSchema,
      response: { 204: NoContentSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      return (await service.deleteSpace((req.params as { id: string }).id))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "not found" });
    }
  );
  app.get(
    "/api/v1/knowledge/spaces/:id/pages",
    route({
      description: "List the pages in a space (with path + OKF type).",
      params: EntityIdParamsSchema,
      response: { 200: SpacePageListResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await service.getSpace(id))) return reply.code(404).send({ error: "not found" });
      const pages = await service.listSpacePages(id);
      return reply.send({ items: pages.map((p) => toApiPage(p)) });
    }
  );
  app.post(
    "/api/v1/knowledge/spaces/:id/pages",
    route({
      description:
        "Author or update an OKF page (full markdown). A reserved index/log path sets a directory override.",
      params: EntityIdParamsSchema,
      body: SpacePageWriteBodySchema,
      response: {
        200: SpacePageWriteResultSchema,
        201: PageResponseSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        401: ErrorSchema,
        503: ErrorSchema,
      },
    }),
    async (req, reply) => {
      const b = req.body as { path: string; content: string };
      const res = await service.writePage({
        spaceId: (req.params as { id: string }).id,
        path: b.path,
        content: b.content,
      });
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
    route({
      description: "Progressive-disclosure index listing for a directory (dirPath, '' = root).",
      params: EntityIdParamsSchema,
      querystring: SpaceNavigateQuerySchema,
      response: { 200: SpaceNavigateResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { dirPath } = req.query as { dirPath?: string };
      const listing = await service.navigateSpace((req.params as { id: string }).id, dirPath ?? "");
      return listing === null
        ? reply.code(404).send({ error: "not found" })
        : reply.send({ listing });
    }
  );
  app.get(
    "/api/v1/knowledge/spaces/:id/graph",
    route({
      description: "Node + edge list for a space's cross-link graph (capped).",
      params: EntityIdParamsSchema,
      response: { 200: SpaceGraphResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const graph = await service.getSpaceGraph((req.params as { id: string }).id);
      return graph ? reply.send(graph) : reply.code(404).send({ error: "not found" });
    }
  );
  app.get(
    "/api/v1/knowledge/pages/:id/backlinks",
    route({
      description: "Pages that link to a page (same- or cross-space) — the 'Linked from' panel.",
      params: EntityIdParamsSchema,
      response: { 200: PageBacklinksResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const items = await service.getBacklinks((req.params as { id: string }).id);
      return items === null ? reply.code(404).send({ error: "not found" }) : reply.send({ items });
    }
  );
  app.get(
    "/api/v1/knowledge/overview",
    route({
      description:
        "Knowledge home overview: every space with page count + last activity, and recently-edited pages.",
      querystring: OverviewQuerySchema,
      response: { 200: OverviewResponseSchema, 401: ErrorSchema },
    }),
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
  const indexAdmin = [
    requireAuth,
    requireAuthorization({
      action: "knowledge_source.index",
      resourceType: "knowledge_source",
      fallback: "admin",
    }),
  ];

  const adminRoute = ({ description, ...schema }: SchemaOptions) => ({
    preHandler: indexAdmin,
    schema: { description, tags, security: sec, ...schema },
  });
  app.post(
    "/api/v1/knowledge/reindex",
    adminRoute({
      description:
        "Re-index knowledge (admin). Body { pageId } re-indexes one page, { spaceId } a whole space, neither a full re-index.",
      body: ReindexBodySchema,
      response: { 200: ReindexedCountResponseSchema, 401: ErrorSchema, 403: ErrorSchema },
    }),
    async (req, reply) => {
      const b = (req.body ?? {}) as { pageId?: string; spaceId?: string };
      return reply.send({
        reindexed: await service.reindexTargeted({ pageId: b.pageId, spaceId: b.spaceId }),
      });
    }
  );
  app.post(
    "/api/v1/knowledge/backfill",
    adminRoute({
      description:
        "Backfill embeddings (admin): re-index every active page with an unembedded or stale-model chunk. No-op without a provider.",
      response: { 200: ReindexedCountResponseSchema, 401: ErrorSchema, 403: ErrorSchema },
    }),
    async (_req, reply) => {
      return reply.send({ reindexed: await service.backfillMissing() });
    }
  );
  app.get(
    "/api/v1/knowledge/index-status",
    adminRoute({
      description:
        "Index health (admin): active pages, chunk embed/lexical counts, max index lag, and pg-boss queue stats.",
      response: { 200: IndexStatusResponseSchema, 401: ErrorSchema, 403: ErrorSchema },
    }),
    async (_req, reply) => {
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
