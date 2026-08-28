import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type * as ChildRoutineHost from "./child-routine-host";
import * as InternalSchemas from "./schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

type DenialGuard = <T>(reply: FastifyReply, run: () => Promise<T>) => Promise<T | undefined>;

export function registerChildRoutineRoutes(
  app: FastifyInstance,
  host: ChildRoutineHost.InternalChildRoutineHost | undefined,
  preHandler: PreHandler[],
  guard: DenialGuard
): void {
  if (host === undefined) return;

  app.post(
    "/api/v1/internal/runs/:runId/child-routines",
    {
      preHandler,
      schema: {
        description: "Start or adopt the child Routine Run a `child_routine` State calls.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalChildRoutineStartBodySchema,
        response: {
          200: InternalSchemas.InternalChildRoutineResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const body = req.body as ChildRoutineHost.StartChildRoutineInput & {
        input?: Record<string, unknown>;
      };
      const started = await guard(reply, () =>
        host.start(DEPLOYMENT_BUSINESS_ID, runId, { ...body, input: body.input ?? {} })
      );
      if (started !== undefined) return reply.send(started);
    }
  );

  app.get(
    "/api/v1/internal/runs/:runId/child-routines",
    {
      preHandler,
      schema: {
        description: "Read the child Routine Run this State occurrence called, if any.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        querystring: InternalSchemas.InternalChildRoutineQuerySchema,
        response: {
          200: InternalSchemas.InternalChildRoutineResponseSchema,
          204: InternalSchemas.InternalChildRoutineEmptyResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const { stateKey } = req.query as { stateKey: string };
      const found = await guard(reply, () =>
        host.find(DEPLOYMENT_BUSINESS_ID, runId, stateKey).then((record) => record ?? null)
      );
      if (found === undefined) return;
      if (found === null) return reply.code(204).send();
      return reply.send(found);
    }
  );
}
