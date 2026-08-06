import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { ChannelRunDeliveryStore } from "@tulipfarm/storage";
import { SurfaceInteractionSchema } from "@tulipfarm/surface";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { durableTurnSubmitter } from "../chat/turn-submit";
import type { ChatTurnPrincipal } from "../conversations/chat-turns";
import type { ConversationStore } from "../conversations/service";
import type { IngressIdentityResolver } from "../ingress/identity";
import type { SurfaceActionStore } from "../surfaces/action-store";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * `/api/v1/internal/surfaces/*` — the generic Surface interaction contract for a provider-originated
 * click (a Slack button/select). Resolves the clicking sender to its own Tulip principal in this
 * process, then delegates straight to `SurfaceActionStore.resolve()` — the same resolution
 * `/api/v1/surfaces/interactions` (web) already performs. No new resolution logic here.
 *
 * Unlike the web route, nothing here streams a reply back to the caller — a Slack click gets no
 * open connection to answer on. So after a successful resolution, this route itself submits a
 * follow-up chat turn (the web client does this client-side via `send(surfaceInteractionAnswer(...))`
 * after `postSurfaceInteraction` resolves) and re-registers a Channel run delivery so the
 * integration-worker's delivery poll loop picks up the agent's reply and posts it back into the same
 * Slack channel/thread the Artifact was presented in.
 */
export interface SurfaceInternalRouteDeps {
  readonly identity: IngressIdentityResolver;
  readonly actions: SurfaceActionStore;
  /** Same revision the handle was minted against (`present`/`request_input`'s `ctx.guardrailRevision`). */
  readonly guardrails?: GuardrailsService;
  readonly store: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly runDeliveries: ChannelRunDeliveryStore;
}

/** Mirrors the web client's `surfaceInteractionAnswer` (`use-chat-stream.ts`) for the channel path. */
function surfaceInteractionAnswer(input: Readonly<Record<string, unknown>>): string {
  if (typeof input.value === "string" && input.value.trim().length > 0) return input.value;
  const entries = Object.entries(input);
  if (entries.length === 0) return "Submitted";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
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
          properties: {
            handle: { type: "string", minLength: 1 },
            provider: { type: "string", minLength: 1 },
            externalSubject: { type: "string", minLength: 1 },
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
        input: Readonly<Record<string, unknown>>;
      };

      const resolution = await deps.identity.resolve({
        slug: body.provider,
        sender: body.externalSubject,
      });
      if (resolution.outcome === "unlinked") {
        return reply.code(400).send({
          error: "Sender is not linked to a Tulip principal.",
          code: "wrong_principal",
        });
      }

      const result = await deps.actions.resolve({
        handle: body.handle,
        principal: resolution.user._id,
        value: body.input,
        // Step-up verification has no channel-side equivalent yet — a handle minted with `stepUp`
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

      const { conversationId, runId } = result.handle;
      if (conversationId !== null && runId !== null) {
        try {
          const delivery = await deps.runDeliveries.find(DEPLOYMENT_BUSINESS_ID, runId);
          if (delivery !== null) {
            const principal: ChatTurnPrincipal = {
              kind: "user",
              id: resolution.user._id,
              businessId: DEPLOYMENT_BUSINESS_ID,
            };
            const content = surfaceInteractionAnswer(result.interaction.input);
            const idempotencyKey = `sf:${result.interaction.id}`;
            const submitter = durableTurnSubmitter({
              store: deps.store,
              invocations: deps.invocations,
              principal,
              payload: {
                conversationId,
                agentId: delivery.agentId,
                message: { role: "user" as const, content },
              },
              agentId: delivery.agentId,
              idempotencyKey,
              log: req.log as FastifyBaseLogger,
            });
            const submission = await submitter.submit({ conversationId, content });
            if (submission.outcome === "submitted" && submission.run) {
              await deps.runDeliveries.create({
                businessId: DEPLOYMENT_BUSINESS_ID,
                runId: submission.run.runId,
                integrationId: delivery.integrationId,
                routeId: delivery.routeId,
                provider: delivery.provider,
                destination: delivery.destination,
                ...(delivery.threadId === undefined ? {} : { threadId: delivery.threadId }),
                agentId: delivery.agentId,
                principalId: resolution.user._id,
                idempotencyKey,
              });
            }
          }
        } catch (error) {
          req.log.warn({ error }, "surface interaction follow-up turn failed");
        }
      }

      return reply.send(result.interaction);
    }
  );
}
