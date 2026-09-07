import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RoutineOwnerAuthorityHost, RoutineOwnerEligibility } from "./routine-owner-authority";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId"],
  properties: { runId: { type: "string", minLength: 1 } },
} as const;

const ResponseSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "ownership"],
      properties: {
        status: { const: "allowed" },
        ownership: { enum: ["personal", "organization", "team"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: { const: "denied" },
        reason: { enum: ["personal_owner_disabled", "personal_owner_missing"] },
      },
    },
  ],
} as const;

export function registerRoutineOwnerAuthorityRoutes(
  app: FastifyInstance,
  host: Pick<RoutineOwnerAuthorityHost, "checkRoutineOwner"> | undefined,
  requireAuth: PreHandler
): void {
  if (host === undefined) return;

  const requireService: PreHandler = async (request, reply) => {
    if (request.principal?.kind !== "service") {
      await reply.code(403).send({ error: "Routine owner authority is service-only" });
    }
  };

  app.get(
    "/api/v1/internal/runs/:runId/routine-owner-status",
    {
      preHandler: [requireAuth, requireService],
      schema: {
        description:
          "Check the live owner eligibility of the exact Routine pinned by a persisted Run.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: ParamsSchema,
        response: {
          200: ResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const result: RoutineOwnerEligibility = await host.checkRoutineOwner({ runId });
      if (result.status === "unavailable") {
        return reply.code(503).send({ error: "routine_owner_unavailable" });
      }
      return reply.send(result);
    }
  );
}
