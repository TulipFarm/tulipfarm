import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { NativeChannelError } from "../integrations/native/credentials";
import { nativeRouteError } from "../integrations/native/routes";
import type { NativeChannelService } from "../integrations/native/service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerNativeChannelInternalRoutes(
  app: FastifyInstance,
  service: NativeChannelService,
  requireAuth: PreHandler
): void {
  app.addHook("preHandler", async (request, reply) => {
    const path = request.routeOptions.url;
    const legacyMint = request.method === "POST" && path === "/api/v1/internal/channels/runs";
    const replyRead =
      request.method === "GET" && path === "/api/v1/internal/channels/runs/:runId/reply";
    const approvalRead =
      request.method === "GET" && path === "/api/v1/internal/channels/runs/:runId/pending-approval";
    if (!legacyMint && !replyRead && !approvalRead) return;
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.principal?.kind !== "service") {
      await reply.code(403).send({ error: "native_channel_service_required" });
      return;
    }
    if (legacyMint) {
      await reply.code(403).send({ error: "native_verified_event_required" });
      return;
    }
    try {
      await service.authorizeReply((request.params as { runId: string }).runId);
    } catch (error) {
      if (error instanceof NativeChannelError && error.status === 503) {
        await reply.send(approvalRead ? { pending: false } : { status: "pending" });
        return;
      }
      await nativeRouteError(error, reply);
    }
  });
  const preHandler = [
    requireAuth,
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.principal?.kind !== "service") {
        await reply.code(403).send({ error: "native_channel_service_required" });
      }
    },
  ];
  const count = Type.Integer({ minimum: 0, maximum: 20 });
  const id = Type.String({ minLength: 1, maxLength: 500 });
  const errors = {
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
    409: ErrorSchema,
    503: ErrorSchema,
  };
  app.post(
    "/api/v1/internal/channels/slack/commands",
    {
      preHandler,
      schema: {
        description:
          "Persist a verified Socket Mode slash command bound to its actual linked sender.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: Type.Object(
          {
            command: Type.Literal("/tulipfarm"),
            team_id: id,
            api_app_id: id,
            user_id: id,
            channel_id: id,
            trigger_id: id,
            text: Type.String({ minLength: 1, maxLength: 100_000 }),
          },
          { additionalProperties: false }
        ),
        response: {
          200: Type.Object({
            outcome: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
            eventId: id,
            response: Type.Union([
              Type.Literal("starting"),
              Type.Literal("unlinked"),
              Type.Literal("denied"),
            ]),
          }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await service.acceptSocketCommand(request.body as Record<string, unknown>)
        );
      } catch (error) {
        return nativeRouteError(error, reply);
      }
    }
  );
  app.post(
    "/api/v1/internal/channels/delivery/authorize",
    {
      preHandler,
      schema: {
        description: "Recheck the linked sender and exact native route immediately before a reply.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: Type.Object(
          {
            integrationId: id,
            routeId: id,
            principalId: id,
            agentId: id,
            destination: id,
            idempotencyKey: id,
          },
          { additionalProperties: false }
        ),
        response: { 200: Type.Object({ allowed: Type.Literal(true) }), ...errors },
      },
    },
    async (request, reply) => {
      try {
        await service.authorizeDelivery(
          request.body as Parameters<NativeChannelService["authorizeDelivery"]>[0]
        );
        return reply.send({ allowed: true });
      } catch (error) {
        return nativeRouteError(error, reply);
      }
    }
  );
  app.post(
    "/api/v1/internal/channels/slack/events",
    {
      preHandler,
      bodyLimit: 1024 * 1024,
      schema: {
        description: "Persist an authenticated Slack Socket Mode event before acknowledgement.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: Type.Object(
          {
            type: Type.Literal("event_callback"),
            api_app_id: id,
            team_id: id,
            event_id: id,
            event: Type.Record(Type.String(), Type.Unknown()),
          },
          { additionalProperties: true }
        ),
        response: {
          200: Type.Object({
            outcome: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
            eventId: id,
          }),
          ...errors,
          413: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await service.acceptSocketEnvelope(request.body as Record<string, unknown>)
        );
      } catch (error) {
        return nativeRouteError(error, reply);
      }
    }
  );
  app.post(
    "/api/v1/internal/channels/events/drain",
    {
      preHandler,
      schema: {
        description: "Claim and dispatch a bounded batch of durable native channel events.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: Type.Object(
          { limit: Type.Integer({ minimum: 1, maximum: 20 }) },
          { additionalProperties: false }
        ),
        response: {
          200: Type.Object({ claimed: count, dispatched: count, denied: count, retrying: count }),
          ...errors,
        },
      },
    },
    async (request) => service.drain((request.body as { limit: number }).limit)
  );
  app.post(
    "/api/v1/internal/channels/github/credential",
    {
      preHandler,
      schema: {
        description:
          "Mint a repository-scoped GitHub reply token for an authorized delivery lease.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: Type.Object(
          {
            integrationId: id,
            routeId: id,
            runId: id,
            destination: id,
            leaseGeneration: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false }
        ),
        response: { 200: Type.Object({ token: id, botUserId: id }), ...errors },
      },
    },
    async (request, reply) => {
      try {
        reply.header("cache-control", "no-store");
        return reply.send(
          await service.githubCredential(
            request.body as Parameters<NativeChannelService["githubCredential"]>[0]
          )
        );
      } catch (error) {
        return nativeRouteError(error, reply);
      }
    }
  );
}
