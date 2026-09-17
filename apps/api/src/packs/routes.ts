import {
  ajv,
  PackCatalogSchema,
  PackPreviewSchema,
  type PackSource,
  PackSourceSchema,
} from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import { PackReadError, type PackService } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerPackRoutes(
  app: FastifyInstance,
  service: PackService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const preHandler = [
    requireAuth,
    requireAuthorization({
      action: "platform.plan.declare",
      resourceType: "platform.plan",
      fallback: "authenticated",
    }),
  ];
  const security: Record<string, string[]>[] = [{ sessionCookie: [] }, { bearerToken: [] }];
  const common = {
    tags: ["Packs"],
    security,
  };
  const errors = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 502: ErrorSchema };
  app.get(
    "/api/v1/packs",
    {
      preHandler,
      schema: {
        ...common,
        description: "Read the public Pack catalog. Does not install or fetch individual Packs.",
        response: { 200: PackCatalogSchema, ...errors },
      },
    },
    async (_request, reply) => {
      try {
        return await service.catalog();
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  app.post<{ Body: PackSource }>(
    "/api/v1/packs/preview",
    {
      preHandler,
      validatorCompiler: ({ schema }) => ajv.compile(schema),
      schema: {
        ...common,
        description:
          "Read and validate a Pack and its dependency graph without changing the instance.",
        body: PackSourceSchema,
        response: { 200: PackPreviewSchema, ...errors },
      },
    },
    async (request, reply) => {
      try {
        return await service.preview(request.body);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
}

function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof PackReadError)
    return reply.code(error.status).send({ error: error.message });
  throw error;
}
