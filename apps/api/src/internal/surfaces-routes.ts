import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import { SurfaceInteractionSchema } from "@tulipfarm/surface";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { IngressIdentityResolver } from "../ingress/identity";
import type { SurfaceActionStore } from "../surfaces/action-store";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * `/api/v1/internal/surfaces/*` — the generic Surface interaction contract for a provider-originated
 * click (a Slack button/select). Resolves the clicking sender to its own Tulip principal in this
 * process, then delegates straight to `SurfaceActionStore.resolve()` — the same resolution
 * `/api/v1/surfaces/interactions` (web) already performs. No new resolution logic here.
 */
export interface SurfaceInternalRouteDeps {
  readonly identity: IngressIdentityResolver;
  readonly actions: SurfaceActionStore;
  /** Same revision the handle was minted against (`present`/`request_input`'s `ctx.guardrailRevision`). */
  readonly guardrails?: GuardrailsService;
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
      return reply.send(result.interaction);
    }
  );
}
