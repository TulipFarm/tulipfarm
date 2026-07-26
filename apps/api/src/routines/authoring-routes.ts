import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { DEPLOYMENT_BUSINESS_ID } from "../identity/principal";
import {
  type CanonicalRoutineAuthoringService,
  RoutineAuthoringError,
  type RoutineAuthoringInput,
} from "./authoring";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type AuthoringService = Pick<CanonicalRoutineAuthoringService, "load" | "analyze" | "propose">;

const PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: { slug: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

const FIXTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["startedAtMs"],
  properties: {
    startedAtMs: { type: "number" },
    tickMs: { type: "number" },
    input: { type: "object", additionalProperties: true },
    trigger: { type: "object", additionalProperties: true },
    model: { type: "object", additionalProperties: true },
    tools: { type: "object", additionalProperties: true },
    events: { type: "object", additionalProperties: true },
  },
} as const;

const AUTHORING_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["baseCommit", "yaml", "fixture"],
  properties: {
    baseCommit: { type: "string", minLength: 1 },
    yaml: { type: "string", minLength: 1 },
    fixture: FIXTURE_SCHEMA,
  },
} as const;

const SAFE_DENIAL = { error: "Routine authoring denied" };

function status(error: RoutineAuthoringError): 403 | 404 | 409 | 422 {
  if (error.code === "unauthorized") return 403;
  if (error.code === "not_found") return 404;
  if (error.code === "invalid_candidate") return 422;
  return 409;
}

function principal(request: FastifyRequest): string {
  return `user:${(request.user as UserDoc)._id}`;
}

function handleError(request: FastifyRequest, reply: FastifyReply, error: unknown, slug: string) {
  if (!(error instanceof RoutineAuthoringError)) throw error;
  request.log.warn({ slug, code: error.code }, "Routine authoring denied");
  return reply.code(status(error)).send(SAFE_DENIAL);
}

/** Canonical Routine reads, dry-run analysis, and proposal-only changeset submission. */
export function registerRoutineAuthoringRoutes(
  app: FastifyInstance,
  service: AuthoringService,
  requireAuth: PreHandler
): void {
  const security: readonly Readonly<Record<string, readonly string[]>>[] = [
    { sessionCookie: [] },
    { bearerToken: [] },
  ];

  app.get(
    "/api/v1/routines/:slug/authoring",
    {
      preHandler: requireAuth,
      schema: {
        description: "Load the immutable canonical Routine base for an authoring draft.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["definition", "baseCommit"],
            properties: {
              definition: { type: "object", additionalProperties: true },
              baseCommit: { type: "string" },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      try {
        return await service.load(slug, principal(request));
      } catch (error) {
        return handleError(request, reply, error, slug);
      }
    }
  );

  app.post(
    "/api/v1/routines/:slug/authoring/analyze",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Validate and simulate a canonical Routine draft without live ports or publication.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        body: AUTHORING_BODY_SCHEMA,
        response: {
          200: { type: "object", additionalProperties: true },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      try {
        return await service.analyze({
          ...(request.body as Omit<RoutineAuthoringInput, "slug" | "principal">),
          slug,
          principal: principal(request),
        });
      } catch (error) {
        return handleError(request, reply, error, slug);
      }
    }
  );

  app.post(
    "/api/v1/routines/:slug/changesets",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Submit an analyzed canonical Routine draft to the Soul changeset and Approval gateway.",
        tags: ["routines"],
        security,
        params: PARAMS_SCHEMA,
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          ...AUTHORING_BODY_SCHEMA,
        },
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: ["changesetId", "status"],
            properties: {
              changesetId: { type: "string" },
              status: { enum: ["validated", "awaiting_approval", "published"] },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = request.body as Omit<RoutineAuthoringInput, "slug" | "principal">;
      try {
        const result = await service.propose({
          ...body,
          slug,
          principal: principal(request),
          businessId: request.principal?.businessId ?? DEPLOYMENT_BUSINESS_ID,
          idempotencyKey: String(request.headers["idempotency-key"]),
        });
        return reply.code(202).send(result);
      } catch (error) {
        return handleError(request, reply, error, slug);
      }
    }
  );
}
