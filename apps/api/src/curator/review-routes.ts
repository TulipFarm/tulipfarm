import { projectShadowEffect } from "@tulipfarm/curator";
import type { CuratorShadowEffectRow, CuratorShadowSummary } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;

export interface CuratorReviewDeps {
  readonly summary: (businessId: string, since: Date) => Promise<CuratorShadowSummary>;
  readonly effects: (
    businessId: string,
    since: Date,
    limit: number
  ) => Promise<CuratorShadowEffectRow[]>;
}

const STR = { type: "string" } as const;

const COUNTED = (properties: Record<string, typeof STR>) => ({
  type: "array" as const,
  items: {
    type: "object" as const,
    required: [...Object.keys(properties), "count"],
    properties: { ...properties, count: { type: "integer" as const } },
  },
});

/**
 * The one way to see what the Curator would have done before it is allowed to do it.
 *
 * Shadow effects are written to a ledger and applied to nothing, so without this route the
 * cutover precondition "shadow validated before go-live" would rest on reading the database by
 * hand. Disclosure is decided per row by `redactShadowEffect`, not here — this route only supplies
 * who is asking.
 */
export function registerCuratorReviewRoutes(
  app: FastifyInstance,
  deps: CuratorReviewDeps,
  businessId: string,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  app.get<{ Querystring: { days?: number; limit?: number } }>(
    "/api/v1/curator/shadow",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "curator.review",
          resourceType: "curator",
          fallback: "admin",
        }),
      ],
      schema: {
        description:
          "What the Curator proposed while in shadow mode: counts by outcome, and recent " +
          "effects. Memory patches and Proposals are shown in full only to the user they " +
          "concern; everyone else sees their shape.",
        tags: ["curator"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            days: { type: "integer", minimum: 1, maximum: 90, default: DEFAULT_WINDOW_DAYS },
            limit: { type: "integer", minimum: 1, maximum: 200, default: DEFAULT_LIMIT },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["windowDays", "summary", "recent"],
            additionalProperties: false,
            properties: {
              windowDays: { type: "integer" },
              summary: {
                type: "object",
                required: ["jobs", "effects", "rejections"],
                additionalProperties: false,
                properties: {
                  jobs: COUNTED({ scope: STR, state: STR }),
                  effects: COUNTED({ kind: STR, state: STR }),
                  rejections: COUNTED({ reason: STR }),
                },
              },
              recent: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "kind", "state", "scope", "createdAt", "disclosure", "content"],
                  additionalProperties: false,
                  properties: {
                    id: STR,
                    kind: STR,
                    state: STR,
                    scope: STR,
                    createdAt: STR,
                    disclosure: { type: "string", enum: ["full", "shape"] },
                    content: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req) => {
      const days = req.query.days ?? DEFAULT_WINDOW_DAYS;
      const since = new Date(Date.now() - days * DAY_MS);
      const [summary, rows] = await Promise.all([
        deps.summary(businessId, since),
        deps.effects(businessId, since, req.query.limit ?? DEFAULT_LIMIT),
      ]);
      // Only a user can be the subject of a memory patch, so a service principal is never one —
      // even if a Role grant lets it read this surface.
      const viewer =
        req.principal?.kind === "user" ? (req.principal.userId ?? req.principal.id) : undefined;
      return {
        windowDays: days,
        summary,
        recent: rows.map((row) =>
          projectShadowEffect(row, row.userId != null && row.userId === viewer)
        ),
      };
    }
  );
}
