import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  KnowledgePage,
  KnowledgeSpace,
  PageRetrievalService,
  RestrictionSubject,
} from "@tulipfarm/knowledge";
import {
  type KnowledgeDenialSink,
  type KnowledgeService,
  recordWriteDenial,
  SpaceNameTakenError,
} from "@tulipfarm/knowledge";
import { encodeCursor, parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../activity/service";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { RequireAuthorization } from "../authz/route-gate";
import type { AuthorLabeller } from "./author-label";
import { refusedAsFileManaged } from "./managed-pages";
import {
  filtersFromQuery,
  pageHitToApi,
  parseIfMatch,
  toApiHit,
  toApiPage,
  toApiRevision,
  toApiSpace,
} from "./mappers";
import { registerOverviewRoutes } from "./overview-routes";
import type { PageReadAuthorizer } from "./page-access";
import type { ReaderDirectory } from "./reader-directory";
import { registerRestrictionRoutes } from "./restriction-routes";
import {
  EntityIdParamsSchema,
  IndexStatusResponseSchema,
  KnowledgeGraphResponseSchema,
  NoContentSchema,
  OverviewQuerySchema,
  OverviewResponseSchema,
  PageBacklinksResponseSchema,
  PageCreateBodySchema,
  PageListQuerySchema,
  PageListResponseSchema,
  PageMentionsResponseSchema,
  PageMoveBodySchema,
  PageMovePreviewSchema,
  PageResponseSchema,
  PageRestrictionResponseSchema,
  PageRevisionCreateBodySchema,
  PageRevisionCreatedResponseSchema,
  PageRevisionListResponseSchema,
  PageUpdateBodySchema,
  PageVisibilityResponseSchema,
  ReindexBodySchema,
  ReindexedCountResponseSchema,
  RestrictionRefusedSchema,
  SearchBodySchema,
  SearchResponseSchema,
  SetPageRestrictionBodySchema,
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
import { registerSpaceRoutes } from "./space-routes";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

type SchemaOptions = {
  description: string;
  body?: object;
  params?: object;
  querystring?: object;
  response: Record<number, object>;
};

/**
 * How many candidates to pull per requested result before authorizing. Denied Pages are removed
 * after ranking, so the surplus is what keeps a page of results full without re-ranking.
 */
const SEARCH_OVERFETCH = 4;

/** Bounds the keyset refill loop so a heavily restricted corpus cannot spin. */
const MAX_REFILL_PASSES = 5;

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  service: KnowledgeService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  gate: PageReadAuthorizer,
  retrieval?: PageRetrievalService,
  activity?: ActivityService,
  authors?: AuthorLabeller,
  readers?: ReaderDirectory,
  denials?: KnowledgeDenialSink
): void {
  const sec: Array<Record<string, string[]>> = [{ sessionCookie: [] }, { bearerToken: [] }];
  const tags = ["knowledge"];

  /**
   * Changing who reads a Page is an ordinary member action — anyone who can read it can reshare it,
   * as in most shared document tools. Declaring it through the gate rather than leaving it implicit
   * is what makes it auditable, and what lets a deployment tighten it without a code change.
   */
  const restrictionWrite = [
    requireAuth,
    requireAuthorization({
      action: "knowledge_page.restrict",
      resourceType: "knowledge_page",
      fallback: "authenticated",
    }),
  ];

  const restrictionRoute = ({ description, ...schema }: SchemaOptions) => ({
    preHandler: restrictionWrite,
    schema: { description, tags, security: sec, ...schema },
  });

  /** Names the ancestor a restriction comes from, so "inherited" points somewhere the author can go. */
  const labelLevel = async (level: { kind: string; id: string }): Promise<string | null> => {
    if (level.kind === "space") return (await service.getSpace(level.id))?.name ?? null;
    return (await service.getPage(level.id))?.title ?? null;
  };

  const route = ({ description, ...schema }: SchemaOptions) => ({
    preHandler: requireAuth,
    schema: { description, tags, security: sec, ...schema },
  });

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

  /**
   * Records a refused write, then answers as if the subject were absent.
   *
   * Authoring upserts by path, so refusing a taken path tells a caller who may read the Space that
   * something sits there. The bit cannot be removed, so it is answered with detection: see
   * `KnowledgeWriteDenial` for why the record names no path, Page or Space.
   */
  const refuseWrite = async (
    req: FastifyRequest,
    reply: FastifyReply,
    action: string,
    subjectKind: "page" | "space"
  ): Promise<FastifyReply> => {
    await recordWriteDenial(denials, {
      actorId: req.user?._id,
      action,
      subjectKind,
      correlationId: req.id,
    });
    return reply.code(404).send({ error: "not found" });
  };

  /** The subset of `ids` this caller may read, as a set, for filtering a derived surface. */
  const visibleSet = async (
    req: FastifyRequest,
    ids: readonly string[]
  ): Promise<ReadonlySet<string>> => {
    const { allowed } = await gate.readablePageIds(req.user?._id, ids);
    return new Set(allowed);
  };

  /** The same, for Spaces. A restricted Space's *name* is already a disclosure. */
  const visibleSpaces = async (
    req: FastifyRequest,
    ids: readonly string[]
  ): Promise<ReadonlySet<string>> => new Set(await gate.readableSpaceIds(req.user?._id, ids));
  app.post(
    "/api/v1/knowledge/pages",
    route({
      description: "Create an authored knowledge page (markdown).",
      body: PageCreateBodySchema,
      response: { 201: PageResponseSchema, 400: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const page = await service.createPage({
        ...(req.body as {
          title: string;
          content: string;
          domain?: string | null;
          tags?: string[];
          alwaysLoadForAgents?: boolean;
        }),
        ...(req.user?._id === undefined ? {} : { ownerPrincipalId: req.user._id }),
      });
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
      const filters = filtersFromQuery(q);

      // Keyset pages are refilled rather than filtered, so a page of results is the same length it
      // would be in a corpus where the denied Pages had never been written.
      const items: KnowledgePage[] = [];
      let cursor = after;
      let lastConsumed: KnowledgePage | undefined;
      let exhausted = false;
      for (let pass = 0; pass < MAX_REFILL_PASSES && items.length < limit; pass += 1) {
        const batch = await service.listPages({ limit, after: cursor, ...filters });
        if (batch.items.length === 0) {
          exhausted = true;
          break;
        }
        const visible = await visibleSet(
          req,
          batch.items.map((d) => d._id)
        );
        for (const doc of batch.items) {
          if (items.length === limit) break;
          lastConsumed = doc;
          if (visible.has(doc._id)) items.push(doc);
        }
        if (batch.nextCursor === null && items.length < limit) {
          exhausted = true;
          break;
        }
        cursor =
          lastConsumed === undefined
            ? cursor
            : { createdAt: lastConsumed.createdAt, _id: lastConsumed._id };
      }

      const statuses = await service.getIndexingStatuses(items.map((d) => d._id));
      return reply.send({
        items: items.map((d) => toApiPage(d, statuses.get(d._id) ?? "pending")),
        nextCursor: exhausted || lastConsumed === undefined ? null : encodeCursor(lastConsumed),
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
    async (req, reply) => {
      const items = await service.listAllPages();
      const visible = await visibleSet(
        req,
        items.map((i) => i.pageId)
      );
      return reply.send({ items: items.filter((i) => visible.has(i.pageId)) });
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
      const { id } = req.params as { id: string };
      // Denied and absent share one 404: a distinct code would confirm the Page exists to someone
      // who may not read it.
      if (!(await gate.canRead(req.user?._id, id))) {
        return reply.code(404).send({ error: "not found" });
      }
      const page = await service.getPage(id);
      if (!page?.active) return reply.code(404).send({ error: "not found" });
      return reply.send({
        ...toApiPage(page, await service.getIndexingStatus(page._id)),
        authorLabel: (await authors?.label(page.authorKind, page.authorId)) ?? null,
        visibility: (await service.getPageScopes([page._id])).get(page._id)?.scope ?? "business",
      });
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
      // Before the version check, not after: 409-against-404 would confirm the Page exists, and
      // an empty body is a legal no-op update whose 200 carries the whole Page back.
      if (!(await (gate.canEdit?.(req.user?._id, "page", id) ?? gate.canRead(req.user?._id, id))))
        return refuseWrite(req, reply, "knowledge.page.update", "page");
      if (await refusedAsFileManaged(service, id, reply)) return reply;
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
      description:
        "Soft-delete a knowledge page. A page that indexes a File is managed on the File and " +
        "answers 409.",
      params: EntityIdParamsSchema,
      querystring: {
        type: "object",
        properties: { ownershipOperationId: { type: "string", format: "uuid" } },
        additionalProperties: false,
      },
      response: {
        204: NoContentSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        401: ErrorSchema,
      },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await (gate.canEdit?.(req.user?._id, "page", id) ?? gate.canRead(req.user?._id, id))))
        return refuseWrite(req, reply, "knowledge.page.delete", "page");
      const { ownershipOperationId } = req.query as { ownershipOperationId?: string };
      try {
        await gate.assertDeleteApproved?.("page", id, ownershipOperationId);
      } catch {
        return reply.code(409).send({ error: "joint owner Approval is required" });
      }
      if (await refusedAsFileManaged(service, id, reply)) return reply;
      return (await service.deletePage(id))
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
        409: ErrorSchema,
        401: ErrorSchema,
      },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { content: string; reason?: string | null };
      if (!(await (gate.canEdit?.(req.user?._id, "page", id) ?? gate.canRead(req.user?._id, id))))
        return refuseWrite(req, reply, "knowledge.page.revise", "page");
      if (await refusedAsFileManaged(service, id, reply)) return reply;
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
      const { id } = req.params as { id: string };
      // History is the Page. Denial and absence share one 404 so neither confirms the other.
      if (!(await (gate.canEdit?.(req.user?._id, "page", id) ?? gate.canRead(req.user?._id, id))))
        return reply.code(404).send({ error: "not found" });
      const revs = await service.listRevisions(id);
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
        // Over-fetch, then authorize, then truncate. Filtering the requested window instead would
        // return short pages, and a short page is itself a signal that something was withheld.
        const hits =
          b.query.trim() === ""
            ? await retrieval.recentPages(limit * SEARCH_OVERFETCH, filters)
            : await retrieval.searchPages({
                query: b.query,
                filters,
                limit: limit * SEARCH_OVERFETCH,
              });
        const visible = await visibleSet(
          req,
          hits.map((h) => h.pageId)
        );
        const allowed = hits.filter((h) => visible.has(h.pageId)).slice(0, limit);
        return reply.send({ results: allowed.map(pageHitToApi), warnings: [] });
      }
      if (b.query.trim() === "") {
        return reply.send({ results: [], warnings: [] });
      }
      const res = await service.search(b.query, filtersFromQuery(b), limit * SEARCH_OVERFETCH);
      const visible = await visibleSet(
        req,
        res.results.map((h) => h.pageId)
      );
      const allowed = res.results.filter((h) => visible.has(h.pageId)).slice(0, limit);
      return reply.send({ results: allowed.map(toApiHit), warnings: res.warnings });
    }
  );

  registerSpaceRoutes({
    app,
    service,
    gate,
    activity,
    route,
    refuseWrite,
    visibleSet,
    visibleSpaces,
  });
  app.get(
    "/api/v1/knowledge/graph",
    route({
      description: "Node + edge list for the Business-wide cross-Space Page link graph (capped).",
      response: { 200: KnowledgeGraphResponseSchema, 401: ErrorSchema },
    }),
    async (req, reply) => reply.send(await service.getKnowledgeGraph((ids) => visibleSet(req, ids)))
  );
  app.get(
    "/api/v1/knowledge/pages/:id/backlinks",
    route({
      description: "Pages that link to a page (same- or cross-space) — the 'Linked from' panel.",
      params: EntityIdParamsSchema,
      response: { 200: PageBacklinksResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await gate.canRead(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const items = await service.getBacklinks(id);
      if (items === null) return reply.code(404).send({ error: "not found" });
      const visible = await visibleSet(
        req,
        items.map((b) => b.sourceId)
      );
      return reply.send({ items: items.filter((b) => visible.has(b.sourceId)) });
    }
  );
  registerRestrictionRoutes({ app, service, gate, route, restrictionRoute, labelLevel, readers });
  /**
   * Moving a Page is a permission change. Both routes refuse identically when the caller cannot
   * read either end, so neither can be used to probe a Space's existence or its allowlist.
   */
  for (const [suffix, apply] of [
    ["/move/preview", false],
    ["/move", true],
  ] as const) {
    app.post(
      `/api/v1/knowledge/pages/:id${suffix}`,
      route({
        description: apply
          ? "Move a page (and everything nested beneath it), reporting the readership it produced."
          : "Report what moving a page would do to its readers, without moving it.",
        params: EntityIdParamsSchema,
        body: PageMoveBodySchema,
        response: {
          200: PageMovePreviewSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          401: ErrorSchema,
        },
      }),
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const dest = req.body as { spaceId?: string; path?: string };
        if (dest.spaceId === undefined && dest.path === undefined)
          return reply.code(400).send({ error: "spaceId or path is required" });
        if (!(await gate.canRead(req.user?._id, id)))
          return reply.code(404).send({ error: "not found" });
        if (dest.spaceId !== undefined && !(await gate.canReadSpace(req.user?._id, dest.spaceId)))
          return reply.code(404).send({ error: "not found" });
        if (apply && (await refusedAsFileManaged(service, id, reply))) return reply;
        const result = apply
          ? await service.movePage(id, dest)
          : await service.previewPageMove(id, dest);
        if (result === null) return reply.code(404).send({ error: "not found" });
        // A nested Page the caller cannot read is omitted, not counted. The move itself still
        // relocates it — this gates the disclosure, not the write — but a count would be enough to
        // tell the caller that a Page exists where they are entitled to see nothing.
        const visibleNested = await visibleSet(
          req,
          result.descendants.map((d) => d.pageId)
        );
        return reply.send({
          ...result,
          descendants: result.descendants.filter((d) => visibleNested.has(d.pageId)),
        });
      }
    );
  }
  registerOverviewRoutes({ app, service, activity, route, adminRoute, visibleSet, visibleSpaces });
}
