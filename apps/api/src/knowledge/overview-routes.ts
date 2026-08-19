/**
 * Instance-wide Knowledge overview and the index maintenance endpoints.
 *
 * Split out of `routes.ts` to keep that file under the repo's size limit. The overview aggregates
 * across every Space, so it is the one surface where an unfiltered count would leak the shape of
 * what the caller cannot read; each total here is built from the gate-filtered set, not from the
 * raw query.
 */

import type { KnowledgeService } from "@tulipfarm/knowledge";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../activity/service";
import { ErrorSchema } from "../auth/schemas";
import { toApiSpace } from "./mappers";
import {
  IndexStatusResponseSchema,
  OverviewQuerySchema,
  OverviewResponseSchema,
  ReindexBodySchema,
  ReindexedCountResponseSchema,
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

export interface OverviewRouteDeps {
  readonly app: FastifyInstance;
  readonly service: KnowledgeService;
  readonly activity?: ActivityService;
  readonly route: RouteFactory;
  /** Adds the `knowledge_source.index` authority check on top of authentication. */
  readonly adminRoute: RouteFactory;
  readonly visibleSet: VisibleFilter;
  readonly visibleSpaces: VisibleFilter;
}

export function registerOverviewRoutes({
  app,
  service,
  activity,
  route,
  adminRoute,
  visibleSet,
  visibleSpaces,
}: OverviewRouteDeps): void {
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
      const visible = await visibleSet(
        req,
        recent.map((p) => p.pageId)
      );
      const visibleRecent = recent.filter((p) => visible.has(p.pageId));
      const recentScopes = await service.getPageScopes(visibleRecent.map((p) => p.pageId));
      const openSpaces = await visibleSpaces(
        req,
        spaces.map((s) => s.space._id)
      );
      // `pageCount` and `lastActivity` are aggregates over every Page in the Space, so inside a
      // Space the caller may read they still describe Pages the caller may not: a count answers
      // "how much am I not being shown" and the clock answers "is someone working on it now".
      // Both are recomputed here, where the principal is known, from readable Pages alone.
      // Scoped to the readable Spaces so the home screen does not enumerate the whole corpus,
      // and so no Page of a hidden Space is ever loaded to be filtered out afterwards.
      const activity = await service.listSpacePageActivity([...openSpaces]);
      const readablePages = await visibleSet(
        req,
        activity.map((p) => p.pageId)
      );
      const rollup = new Map<string, { count: number; latest: Date | null }>();
      for (const page of activity) {
        if (!readablePages.has(page.pageId)) continue;
        const acc = rollup.get(page.spaceId) ?? { count: 0, latest: null };
        acc.count += 1;
        if (acc.latest === null || page.updatedAt > acc.latest) acc.latest = page.updatedAt;
        rollup.set(page.spaceId, acc);
      }
      return reply.send({
        spaces: spaces
          .filter((s) => openSpaces.has(s.space._id))
          .map((s) => {
            const acc = rollup.get(s.space._id);
            const latest = acc?.latest;
            return {
              ...toApiSpace(s.space),
              pageCount: acc?.count ?? 0,
              lastActivity: (latest && latest > s.space.updatedAt
                ? latest
                : s.space.updatedAt
              ).toISOString(),
            };
          }),
        recent: visibleRecent.map((p) => ({
          pageId: p.pageId,
          spaceId: p.spaceId,
          spaceName: p.spaceName,
          path: p.path,
          title: p.title,
          authorKind: p.authorKind ?? null,
          authorId: p.authorId ?? null,
          visibility: recentScopes.get(p.pageId)?.scope ?? "business",
          updatedAt: p.updatedAt.toISOString(),
        })),
      });
    }
  );
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
