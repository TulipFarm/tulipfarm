import type { RoutineCatalog, RoutineCatalogDetail } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { RequireAuthorization, RouteAuthorization } from "../authz/route-gate";
import { routineSchema, security } from "./catalog-routes";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** One Run of one Routine, as the Routine screen's history list reads it. */
export interface RoutineRunSummary {
  readonly id: string;
  readonly routineSlug: string;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface RoutineRunReader {
  /** Newest first, and only Runs executing `routineId` as pinned in their bundle. */
  listByRoutine(input: {
    readonly routineId: string;
    readonly routineSlug: string;
    readonly limit: number;
  }): Promise<readonly RoutineRunSummary[]>;
}

export interface RoutineDetailDeps {
  readonly catalog: RoutineCatalog;
  readonly runs: RoutineRunReader;
  /**
   * Mints the Run. The caller is the signed-in user, not a service identity: a Run started from
   * this button acts with exactly the authority of the person who pressed it.
   */
  readonly trigger: (
    slug: string,
    inputs: Record<string, unknown> | undefined,
    caller: { readonly kind: string; readonly id: string },
    idempotencyKey?: string
  ) => Promise<{ readonly runId: string }>;
}

const READ: RouteAuthorization = {
  action: "routine.read",
  resourceType: "routine",
  fallback: "authenticated",
};

const TRIGGER: RouteAuthorization = {
  action: "routine.trigger",
  resourceType: "routine",
  fallback: "authenticated",
};

const PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: { slug: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

const DETAIL_SCHEMA = {
  ...routineSchema,
  required: [...routineSchema.required, "definition", "hash"],
  properties: {
    ...routineSchema.properties,
    definition: { type: "object", additionalProperties: true },
    hash: { type: "string" },
  },
} as const;

const RUN_SCHEMA = {
  type: "object",
  required: ["id", "routineSlug", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    routineSlug: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "string" },
    startedAt: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
  },
} as const;

const NOT_FOUND = { error: "No published Routine with that slug." };

function caller(request: FastifyRequest): { kind: string; id: string } {
  return { kind: "user", id: (request.user as UserDoc)._id };
}

/**
 * The Routine screen's read and trigger plane. Reads come from the verified active bundle only,
 * never the authored checkout: the screen must describe the Routine a Run would actually execute.
 */
export function registerRoutineDetailRoutes(
  app: FastifyInstance,
  deps: RoutineDetailDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const load = (slug: string): Promise<RoutineCatalogDetail | undefined> => deps.catalog.get(slug);

  app.get(
    "/api/v1/routines/:slug",
    {
      preHandler: [requireAuth, requireAuthorization(READ)],
      schema: {
        description: "Read one published Routine from the verified active Soul bundle.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        response: { 200: DETAIL_SCHEMA, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const detail = await load(slug);
      if (!detail) return reply.status(404).send(NOT_FOUND);
      return {
        id: detail.id,
        slug: detail.slug,
        displayName: detail.displayName,
        authoredVersion: detail.authoredVersion,
        triggers: detail.triggers,
        definition: detail.definition,
        hash: detail.bundleDigest,
      };
    }
  );

  app.get(
    "/api/v1/routines/:slug/runs",
    {
      preHandler: [requireAuth, requireAuthorization(READ)],
      schema: {
        description: "List the newest Runs that executed this Routine.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        },
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: RUN_SCHEMA } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const { limit } = request.query as { limit?: number };
      const detail = await load(slug);
      if (!detail) return reply.status(404).send(NOT_FOUND);
      return {
        items: await deps.runs.listByRoutine({
          routineId: detail.id,
          routineSlug: detail.slug,
          limit: limit ?? 50,
        }),
      };
    }
  );

  app.post(
    "/api/v1/routines/:slug/runs",
    {
      preHandler: [requireAuth, requireAuthorization(TRIGGER)],
      schema: {
        description:
          "Start one Run of this Routine as the signed-in user. Send an `Idempotency-Key` " +
          "header to make a retried request safe; without one every request starts a Run, " +
          "because a second deliberate press is a second Run.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { inputs: { type: "object", additionalProperties: true } },
        },
        response: {
          202: {
            type: "object",
            required: ["runId"],
            properties: { runId: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const detail = await load(slug);
      if (!detail) return reply.status(404).send(NOT_FOUND);
      const body = (request.body ?? {}) as { inputs?: Record<string, unknown> };
      const key = (request.headers["idempotency-key"] as string | undefined) ?? undefined;
      try {
        const { runId } = await deps.trigger(slug, body.inputs, caller(request), key);
        return reply.status(202).send({ runId });
      } catch (error) {
        // The gateway refuses an unpublished definition or a payload its schema rejects. Both are
        // the caller's request being wrong about this Routine, not the server failing.
        request.log.warn({ err: error, slug }, "manual Routine trigger refused");
        return reply
          .status(422)
          .send({ error: "This Routine could not be started with those inputs." });
      }
    }
  );
}
