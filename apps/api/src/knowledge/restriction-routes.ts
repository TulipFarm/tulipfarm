/**
 * Who may read a Page or a Space, as its own sub-resource.
 *
 * Split out of `routes.ts` to keep that file under the repo's size limit. These routes share one
 * property that the CRUD routes do not: each of them changes or reports *readership*, so each has
 * to refuse identically to a caller who cannot already read the subject — otherwise the refusal
 * itself discloses that the subject exists.
 */

import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { KnowledgeService, RestrictionSubject } from "@tulipfarm/knowledge";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { refusedAsFileManaged } from "./managed-pages";
import type { PageReadAuthorizer } from "./page-access";
import type { ReaderDirectory } from "./reader-directory";
import {
  EntityIdParamsSchema,
  PageRestrictionResponseSchema,
  PageVisibilityResponseSchema,
  RestrictionRefusedSchema,
  SetPageRestrictionBodySchema,
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

export interface RestrictionRouteDeps {
  readonly app: FastifyInstance;
  readonly service: KnowledgeService;
  readonly gate: PageReadAuthorizer;
  /** Session-authenticated read. */
  readonly route: RouteFactory;
  /** Adds the `knowledge_page.restrict` authority check on top of authentication. */
  readonly restrictionRoute: RouteFactory;
  readonly labelLevel: (level: { kind: string; id: string }) => Promise<string | null>;
  readonly readers?: ReaderDirectory;
}

export function registerRestrictionRoutes({
  app,
  service,
  gate,
  route,
  restrictionRoute,
  labelLevel,
  readers,
}: RestrictionRouteDeps): void {
  // Restricting a Space restricts everything beneath it, now and later: the gate resolves a Page
  // against its Space at read time rather than stamping Pages on write, so a Space can be closed
  // long after its Pages were authored.
  app.get(
    "/api/v1/knowledge/spaces/:id/restriction",
    route({
      description:
        "Who can read a space: Business-wide, or the exact allowlist it is restricted to.",
      params: EntityIdParamsSchema,
      response: { 200: PageRestrictionResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await gate.canReadSpace(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const restriction = await service.getSpaceRestriction(id);
      if (restriction === null) return reply.code(404).send({ error: "not found" });
      return reply.send(restriction);
    }
  );
  app.put(
    "/api/v1/knowledge/spaces/:id/restriction",
    restrictionRoute({
      description:
        "Restrict a space to named Users, Teams, and Roles. Every page beneath it inherits, including pages created later.",
      params: EntityIdParamsSchema,
      body: SetPageRestrictionBodySchema,
      response: {
        200: PageRestrictionResponseSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        409: RestrictionRefusedSchema,
        401: ErrorSchema,
      },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await gate.canReadSpace(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const { subjects } = req.body as { subjects: RestrictionSubject[] };
      const outcome = await service.setSpaceRestriction(id, subjects);
      if (outcome === "empty_subjects")
        return reply.code(400).send({ error: "at least one subject is required" });
      if (outcome === "not_found") return reply.code(404).send({ error: "not found" });
      return reply.send(await service.getSpaceRestriction(id));
    }
  );
  app.delete(
    "/api/v1/knowledge/spaces/:id/restriction",
    restrictionRoute({
      description:
        "Remove a space's restriction. Pages carrying a restriction of their own keep it.",
      params: EntityIdParamsSchema,
      response: { 200: PageRestrictionResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await gate.canReadSpace(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const outcome = await service.clearSpaceRestriction(id);
      if (outcome !== "ok") return reply.code(404).send({ error: "not found" });
      return reply.send(await service.getSpaceRestriction(id));
    }
  );
  // Readership is its own sub-resource, not a field on the Page body: changing who may read
  // something must be a distinct action from editing what it says, so it cannot happen by accident
  // while saving content.
  app.get(
    "/api/v1/knowledge/pages/:id/restriction",
    route({
      description:
        "Who can read a page: Business-wide, or the exact allowlist it is restricted to.",
      params: EntityIdParamsSchema,
      response: { 200: PageRestrictionResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await gate.canRead(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const restriction = await service.getPageRestriction(id);
      if (restriction === null) return reply.code(404).send({ error: "not found" });
      return reply.send(restriction);
    }
  );
  app.get(
    "/api/v1/knowledge/pages/:id/visibility",
    route({
      description:
        "Who can read a page, in names — including readers granted by a Team or Role, and restrictions inherited from an ancestor.",
      params: EntityIdParamsSchema,
      response: { 200: PageVisibilityResponseSchema, 404: ErrorSchema, 401: ErrorSchema },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await gate.canRead(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      const source = await service.getPageVisibility(id);
      if (source === null) return reply.code(404).send({ error: "not found" });

      const restricted = source.own.length > 0 || source.inheritedFrom !== null;
      return reply.send({
        restricted,
        scope:
          source.own.length > 0 ? "own" : source.inheritedFrom !== null ? "inherited" : "business",
        own: source.own,
        inheritedFrom: source.inheritedFrom
          ? { ...source.inheritedFrom, label: await labelLevel(source.inheritedFrom) }
          : null,
        // An unrestricted Page is open to the whole Business; enumerating everyone would answer a
        // question nobody asked and turn every Page into a staff directory.
        readers: restricted
          ? ((await readers?.expand(DEPLOYMENT_BUSINESS_ID, source.readers)) ?? [])
          : [],
      });
    }
  );
  app.put(
    "/api/v1/knowledge/pages/:id/restriction",
    restrictionRoute({
      description:
        "Restrict a page to named Users, Teams, and Roles. Replaces Business-wide read rather than adding exceptions.",
      params: EntityIdParamsSchema,
      body: SetPageRestrictionBodySchema,
      response: {
        200: PageRestrictionResponseSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        409: RestrictionRefusedSchema,
        401: ErrorSchema,
      },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // Answering 403 would confirm the Page exists to someone who may not know it does.
      if (!(await gate.canRead(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      if (await refusedAsFileManaged(service, id, reply)) return reply;
      const { subjects } = req.body as { subjects: RestrictionSubject[] };

      // An ancestor's restriction is a ceiling, not a suggestion. Applying the allowed half would
      // narrow the Page to something the author never asked for and believes they granted wider.
      const source = await service.getPageVisibility(id);
      if (source?.inheritedFrom && source.ancestorReaders) {
        const allowed = new Set(source.ancestorReaders.map((p) => `${p.kind}\u0000${p.id}`));
        const beyond = subjects.filter((sub) => !allowed.has(`${sub.kind}\u0000${sub.id}`));
        if (beyond.length > 0) {
          return reply.code(409).send({
            error: `cannot grant beyond the restriction inherited from this page's ancestor`,
            constrainedBy: {
              ...source.inheritedFrom,
              label: await labelLevel(source.inheritedFrom),
            },
            rejected: beyond,
          });
        }
      }

      const outcome = await service.setPageRestriction(id, subjects);
      if (outcome === "empty_subjects")
        return reply.code(400).send({ error: "at least one subject is required" });
      if (outcome === "not_found") return reply.code(404).send({ error: "not found" });
      return reply.send(await service.getPageRestriction(id));
    }
  );
  app.delete(
    "/api/v1/knowledge/pages/:id/restriction",
    restrictionRoute({
      description:
        "Remove a page's restriction, returning it to Business-wide read. A page that indexes a " +
        "File is managed on the File and answers 409.",
      params: EntityIdParamsSchema,
      response: {
        200: PageRestrictionResponseSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        401: ErrorSchema,
      },
    }),
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await gate.canRead(req.user?._id, id)))
        return reply.code(404).send({ error: "not found" });
      if (await refusedAsFileManaged(service, id, reply)) return reply;
      const outcome = await service.clearPageRestriction(id);
      if (outcome !== "ok") return reply.code(404).send({ error: "not found" });
      return reply.send(await service.getPageRestriction(id));
    }
  );
}
