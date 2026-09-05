/**
 * Space CRUD and the Space-scoped Page surfaces.
 *
 * Split out of `routes.ts` to keep that file under the repo's size limit. Every route here reaches
 * a Space by id, so every one of them goes through `gate.canReadSpace` first and answers 404 — not
 * 403 — when it fails, because the existence of a restricted Space is itself a disclosure.
 */

import type { KnowledgeService } from "@tulipfarm/knowledge";
import { SpaceNameTakenError } from "@tulipfarm/knowledge";
import { parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../activity/service";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { toApiPage, toApiSpace } from "./mappers";
import type { PageReadAuthorizer } from "./page-access";
import {
  EntityIdParamsSchema,
  NoContentSchema,
  PageResponseSchema,
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

type RouteFactory = (options: SchemaOptions) => {
  preHandler: PreHandler | PreHandler[];
  schema: object;
};

/** The subset of `ids` this caller may read, for filtering a derived surface. */
type VisibleFilter = (req: FastifyRequest, ids: readonly string[]) => Promise<ReadonlySet<string>>;

export interface SpaceRouteDeps {
  readonly app: FastifyInstance;
  readonly service: KnowledgeService;
  readonly gate: PageReadAuthorizer;
  readonly activity?: ActivityService;
  readonly route: RouteFactory;
  /** Records the refusal, then answers as if the subject were absent. */
  readonly refuseWrite: (
    req: FastifyRequest,
    reply: FastifyReply,
    action: string,
    subjectKind: "page" | "space"
  ) => Promise<FastifyReply>;
  readonly visibleSet: VisibleFilter;
  readonly visibleSpaces: VisibleFilter;
}

export function registerSpaceRoutes({
  app,
  service,
  gate,
  activity,
  route,
  refuseWrite,
  visibleSet,
  visibleSpaces,
}: SpaceRouteDeps): void {
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
      const res = await service.createSpace({
        ...(req.body as { name: string; description?: string | null }),
        ...(req.user?._id === undefined ? {} : { ownerPrincipalId: req.user._id }),
      });
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
      const visible = await visibleSpaces(
        req,
        page.items.map((s) => s._id)
      );
      return reply.send({
        items: page.items.filter((s) => visible.has(s._id)).map(toApiSpace),
        nextCursor: page.nextCursor,
      });
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
      const { id } = req.params as { id: string };
      // 404 rather than 403: a 403 confirms the Space exists to someone who may not know it does.
      if (
        !(await (gate.canEdit?.(req.user?._id, "space", id) ??
          gate.canReadSpace(req.user?._id, id)))
      )
        return reply.code(404).send({ error: "not found" });
      const s = await service.getSpace(id);
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
      if (!(await gate.canReadSpace(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
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
      if (
        !(await (gate.canEdit?.(req.user?._id, "space", id) ??
          gate.canReadSpace(req.user?._id, id)))
      )
        return reply.code(404).send({ error: "not found" });
      try {
        await gate.assertDeleteApproved?.(
          "space",
          id,
          (req.query as { ownershipOperationId?: string }).ownershipOperationId
        );
      } catch {
        return reply.code(409).send({ error: "joint owner Approval is required" });
      }
      return (await service.deleteSpace(id))
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
      if (!(await gate.canReadSpace(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      if (!(await service.getSpace(id))) return reply.code(404).send({ error: "not found" });
      const pages = await service.listSpacePages(id);
      const { allowed } = await gate.readablePageIds(
        req.user?._id,
        pages.map((p) => p._id)
      );
      const visible = new Set(allowed);
      const shown = pages.filter((p) => visible.has(p._id));
      const scopes = await service.getPageScopes(shown.map((p) => p._id));
      return reply.send({
        items: shown.map((p) => ({
          ...toApiPage(p),
          visibility: scopes.get(p._id)?.scope ?? "business",
        })),
      });
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
      const spaceId = (req.params as { id: string }).id;
      // Every other /spaces/:id route answers a restricted Space as if it were absent. Without the
      // same check here the Space stays addressable: authoring at a free path succeeds while a path
      // held by a hidden Page 404s, which tells an outsider which paths are occupied — and lets
      // them plant Pages that the Space's own members would read back as knowledge.
      if (
        !(await (gate.canEdit?.(req.user?._id, "space", spaceId) ??
          gate.canReadSpace(req.user?._id, spaceId)))
      )
        return refuseWrite(req, reply, "knowledge.page.author", "space");
      // writePage upserts by path, so a taken path is an update in disguise. Answering 404 keeps a
      // restricted Page from being overwritten and re-attributed by someone who cannot read it,
      // and matches what a caller who probed the path directly would already have been told.
      const existing = await service.getPageByPath(spaceId, b.path);
      if (
        existing &&
        !(await (gate.canEdit?.(req.user?._id, "page", existing._id) ??
          gate.canRead(req.user?._id, existing._id)))
      )
        return refuseWrite(req, reply, "knowledge.page.author", "page");
      const res = await service.writePage({
        spaceId,
        path: b.path,
        content: b.content,
        author: req.user?._id ? { kind: "user", id: req.user._id } : null,
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
      const { id } = req.params as { id: string };
      if (!(await gate.canReadSpace(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const pages = await service.listSpacePages(id);
      const visible = await visibleSet(
        req,
        pages.map((p) => p._id)
      );
      const listing = await service.navigateSpace(id, dirPath ?? "", visible);
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
      const { id } = req.params as { id: string };
      if (!(await gate.canReadSpace(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const graph = await service.getSpaceGraph(id, (ids) => visibleSet(req, ids));
      return graph ? reply.send(graph) : reply.code(404).send({ error: "not found" });
    }
  );
}
