import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type * as RoutineApprovalHost from "./routine-approval-host";
import * as InternalSchemas from "./schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

type DenialGuard = <T>(reply: FastifyReply, run: () => Promise<T>) => Promise<T | undefined>;

export function registerRoutineApprovalRoutes(
  app: FastifyInstance,
  host: RoutineApprovalHost.InternalRoutineApprovalHost | undefined,
  preHandler: PreHandler[],
  guard: DenialGuard
): void {
  if (host === undefined) return;

  app.post(
    "/api/v1/internal/runs/:runId/routine-approvals",
    {
      preHandler,
      schema: {
        description: "Open or replay a Routine approval and register its wait.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalRoutineApprovalOpenBodySchema,
        response: {
          200: InternalSchemas.InternalRoutineApprovalResponseSchema,
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
      const body = req.body as RoutineApprovalHost.OpenRoutineApprovalInput;
      const opened = await guard(reply, () => host.open(DEPLOYMENT_BUSINESS_ID, runId, body));
      if (opened !== undefined) return reply.send(opened);
    }
  );

  app.get(
    "/api/v1/internal/runs/:runId/routine-approvals",
    {
      preHandler,
      schema: {
        description: "Read the decision for a Routine approval, if one exists.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        querystring: InternalSchemas.InternalRoutineApprovalQuerySchema,
        response: {
          200: InternalSchemas.InternalRoutineApprovalResponseSchema,
          204: InternalSchemas.InternalRoutineApprovalEmptyResponseSchema,
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
