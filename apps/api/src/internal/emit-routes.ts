import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type * as EmitHost from "./emit-host";
import * as InternalSchemas from "./schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

type DenialGuard = <T>(reply: FastifyReply, run: () => Promise<T>) => Promise<T | undefined>;

export function registerEmitRoutes(
  app: FastifyInstance,
  host: EmitHost.InternalEmitHost | undefined,
  preHandler: PreHandler[],
  guard: DenialGuard
): void {
  if (host === undefined) return;

  app.post(
    "/api/v1/internal/runs/:runId/emissions",
    {
      preHandler,
      schema: {
        description: "Announce the internal event an `emit` State raises, and report its binding.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalEmitBodySchema,
        response: {
          200: InternalSchemas.InternalEmitResponseSchema,
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
      const body = req.body as EmitHost.EmitEventInput & { data?: Record<string, unknown> };
      const emitted = await guard(reply, () =>
        host.emit(DEPLOYMENT_BUSINESS_ID, runId, { ...body, data: body.data ?? {} })
      );
      if (emitted !== undefined) return reply.send(emitted);
    }
  );
}
