import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import { contentText } from "@tulipfarm/schema";
import type { ChannelRunDeliveryStore } from "@tulipfarm/storage";
import { SurfaceInteractionSchema } from "@tulipfarm/surface";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { ChatTurnPrincipal } from "../conversations/chat-turns";
import { chatConversationService } from "../conversations/chat-turns";
import type { ConversationStore } from "../conversations/service";
import type { IngressIdentityResolver } from "../ingress/identity";
import type { PendingSurfaceAction, SurfaceActionStore } from "../surfaces/action-store";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SurfaceInternalRouteDeps {
  readonly identity: IngressIdentityResolver;
  readonly actions: SurfaceActionStore;
  readonly guardrails?: GuardrailsService;
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly runDeliveries: ChannelRunDeliveryStore;
}

function surfaceInteractionAnswer(input: Readonly<Record<string, unknown>>): string {
  if (typeof input.value === "string" && input.value.trim().length > 0) return input.value;
  const entries = Object.entries(input);
  if (entries.length === 0) return "Submitted";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

async function processSurfaceInteraction(
  work: PendingSurfaceAction,
  deps: SurfaceInternalRouteDeps
): Promise<"processed" | "replayed"> {
  if (work.handle.consumedAt !== null) return "replayed";
  const { conversationId, runId } = work.handle;
  if (conversationId === null || runId === null) {
    await deps.actions.complete({
      handle: work.handle.handle,
      interactionId: work.interactionId,
    });
    return "processed";
  }

  const sourceDelivery = await deps.runDeliveries.find(DEPLOYMENT_BUSINESS_ID, runId);
  if (sourceDelivery === null) throw new Error("surface_source_delivery_missing");
  const idempotencyKey = `sf:${work.interactionId}`;
  const turn = await deps.store.findTurnByIdempotencyKey(DEPLOYMENT_BUSINESS_ID, idempotencyKey);
  if (turn === undefined) throw new Error("surface_follow_up_turn_missing");
  const messages = await deps.store.listMessages(DEPLOYMENT_BUSINESS_ID, conversationId);
  const request = messages.find((message) => message.id === turn.requestMessageId);
  if (request === undefined) throw new Error("surface_follow_up_message_missing");
  const content = contentText(request.content);
  const principal: ChatTurnPrincipal = {
    kind: work.principalKind,
    id: work.principal,
    businessId: DEPLOYMENT_BUSINESS_ID,
  };
  const conversations = chatConversationService(
    { store: deps.store, invocations: deps.invocations },
    {
      principal,
      payload: {
        conversationId,
        agentId: sourceDelivery.agentId,
        message: { role: "user" as const, content },
      },
      agentId: sourceDelivery.agentId,
    }
  );
  const submission = await conversations.dispatchReservedTurn({
    businessId: DEPLOYMENT_BUSINESS_ID,
    idempotencyKey,
  });
  await deps.runDeliveries.create({
    businessId: DEPLOYMENT_BUSINESS_ID,
    runId: submission.runId,
    integrationId: sourceDelivery.integrationId,
    routeId: sourceDelivery.routeId,
    provider: sourceDelivery.provider,
    destination: sourceDelivery.destination,
    ...(sourceDelivery.threadId === undefined ? {} : { threadId: sourceDelivery.threadId }),
    agentId: sourceDelivery.agentId,
    principalId: work.principal,
    idempotencyKey,
  });
  await deps.actions.complete({
    handle: work.handle.handle,
    interactionId: work.interactionId,
  });
  return "processed";
}

export function registerSurfaceInternalRoutes(
  app: FastifyInstance,
  deps: SurfaceInternalRouteDeps,
  requireAuth: PreHandler
): void {
  const requireService: PreHandler = async (req, reply) => {
    if (req.principal?.kind !== "service") {
      await reply.code(403).send({ error: "internal surface host is service-only" });
    }
  };
  const preHandler = [requireAuth, requireService];

  app.post(
    "/api/v1/internal/surfaces/interactions",
    {
      preHandler,
      schema: {
        description:
          "Resolve a provider-originated Surface interaction (a Slack button/select click) to the " +
          "same interaction contract web callers use. The clicking sender is resolved to a Tulip " +
          "principal here, in this process — a worker states only the click, never the identity it " +
          "decides as.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["handle", "provider", "externalSubject", "input"],
          additionalProperties: false,
          anyOf: [
            {
              properties: { provider: { not: { const: "slack" } } },
              required: ["provider"],
            },
            {
              properties: { provider: { const: "slack" } },
              required: ["provider", "externalTenantId"],
            },
          ],
          properties: {
            handle: { type: "string", minLength: 1 },
            provider: { type: "string", minLength: 1 },
            externalSubject: { type: "string", minLength: 1 },
            externalTenantId: { type: "string", minLength: 1 },
            input: { type: "object" },
          },
        },
        response: {
          200: SurfaceInteractionSchema,
          400: {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        handle: string;
        provider: string;
        externalSubject: string;
        externalTenantId?: string;
        input: Readonly<Record<string, unknown>>;
      };

      const resolution = await deps.identity.resolve({
        slug: body.provider,
        sender: body.externalSubject,
        externalTenantId: body.externalTenantId,
      });
      if (resolution.outcome === "unlinked") {
        return reply.code(400).send({
          error: "Sender is not linked to a Tulip principal.",
          code: "wrong_principal",
        });
      }

      const result = await deps.actions.reserve({
        handle: body.handle,
        // The sender's *authority*, not the account they were matched to. A guest holds an id no
        // audience contains, so a provider-asserted match fails `wrong_principal` here.
        principal: resolution.principalId,
        principalKind: resolution.principalKind,
        value: body.input,
        // is refused here rather than silently treated as satisfied.
        stepUpSatisfied: false,
        currentGuardrailRevision: deps.guardrails?.revision ?? "none",
      });
      if (!result.ok) {
        return reply.code(400).send({
          error: "Surface interaction was rejected.",
          code: result.code,
        });
      }

      if (result.outcome !== "completed") {
        const { conversationId, runId } = result.handle;
        if (conversationId !== null && runId !== null) {
          const delivery = await deps.runDeliveries.find(DEPLOYMENT_BUSINESS_ID, runId);
          if (delivery === null) throw new Error("surface_source_delivery_missing");
          const principal: ChatTurnPrincipal = {
            kind: resolution.principalKind,
            id: resolution.principalId,
            businessId: DEPLOYMENT_BUSINESS_ID,
          };
          const content = surfaceInteractionAnswer(result.interaction.input);
          const idempotencyKey = `sf:${result.interaction.id}`;
          const conversations = chatConversationService(
            { store: deps.store, invocations: deps.invocations },
            {
              principal,
              payload: {
                conversationId,
                agentId: delivery.agentId,
                message: { role: "user" as const, content },
              },
              agentId: delivery.agentId,
            }
          );
          await conversations.reserveTurn({
            businessId: DEPLOYMENT_BUSINESS_ID,
            conversationId,
            content,
            idempotencyKey,
          });
        } else {
          await deps.actions.complete({
            handle: body.handle,
            interactionId: result.interaction.id,
          });
        }
      }

      return reply.send(result.interaction);
    }
  );

  app.post(
    "/api/v1/internal/surfaces/interactions/:interactionId/process",
    {
      preHandler,
      schema: {
        description:
          "Dispatch a durably reserved Surface interaction after provider acknowledgement.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: {
          type: "object",
          required: ["interactionId"],
          properties: { interactionId: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: { outcome: { enum: ["processed", "replayed"] } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { interactionId } = req.params as { interactionId: string };
      const work = await deps.actions.findReservation(interactionId);
      if (work === undefined) {
        return reply.code(404).send({ error: "Surface interaction reservation not found." });
      }
      return reply.send({ outcome: await processSurfaceInteraction(work, deps) });
    }
  );

  app.post(
    "/api/v1/internal/surfaces/interactions/recover",
    {
      preHandler,
      schema: {
        description:
          "Recover Surface interactions whose post-ack dispatch did not run in the Socket process.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["attempted", "processed"],
            properties: {
              attempted: { type: "integer", minimum: 0 },
              processed: { type: "integer", minimum: 0 },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const pending = await deps.actions.listPending(new Date(Date.now() - 3_000), 20);
      let processed = 0;
      for (const work of pending) {
        try {
          await processSurfaceInteraction(work, deps);
          processed += 1;
        } catch (error) {
          req.log.warn(
            { err: error, interactionId: work.interactionId },
            "Surface interaction recovery deferred"
          );
        }
      }
      return reply.send({ attempted: pending.length, processed });
    }
  );
}
