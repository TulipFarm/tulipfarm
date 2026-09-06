import type { PersistedWebhookDelivery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { AuthorizationCheck } from "../authz/route-gate";
import type { RequestPrincipal } from "../identity/principal";

/**
 * Operator surfaces over the webhook inbox: see what failed, and run it again.
 *
 * Both are gated. A replay re-runs whatever a Routine does on that event using the business's own
 * Connection, so it is a way to cause provider effects, not a way to read a log.
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The subset of the inbox these routes may touch. Nothing here can record a new delivery. */
export interface DeliveryInboxReader {
  listDeadLettered(
    businessId: string,
    limit?: number
  ): Promise<readonly PersistedWebhookDelivery[]>;
  findById(businessId: string, id: string): Promise<PersistedWebhookDelivery | null>;
  replay(businessId: string, id: string, newId: string): Promise<PersistedWebhookDelivery | null>;
}

export interface DeliveryRouteDeps {
  readonly inbox: DeliveryInboxReader;
  readonly requireAuth: PreHandler;
  readonly authorizationCheck: AuthorizationCheck;
  readonly newDeliveryId?: () => string;
  readonly audit?: (
    req: FastifyRequest,
    action: string,
    subject: string,
    detail: Record<string, unknown>
  ) => Promise<void>;
}

const DeliverySchema = {
  type: "object",
  required: ["id", "integrationId", "state", "receivedAt"],
  properties: {
    id: { type: "string" },
    integrationId: { type: "string" },
    integrationMajorVersion: { type: "number" },
    connectionId: { type: ["string", "null"] },
    eventType: { type: ["string", "null"] },
    state: { type: "string" },
    attempts: { type: "number" },
    lastError: { type: ["string", "null"] },
    receivedAt: { type: "string" },
    replayOfId: { type: ["string", "null"] },
    replayable: { type: "boolean" },
  },
} as const;

/**
 * What an operator is shown.
 *
 * The payload is not in it, encrypted or otherwise: this endpoint answers "what broke", and a
 * provider payload is business data whose reach a delivery listing should not widen.
 */
function summarize(delivery: PersistedWebhookDelivery) {
  return {
    id: delivery.id,
    integrationId: delivery.integrationId,
    integrationMajorVersion: delivery.integrationMajorVersion,
    connectionId: delivery.connectionId,
    eventType: delivery.eventType,
    state: delivery.state,
    attempts: delivery.attempts,
    lastError: delivery.lastError,
    receivedAt: delivery.receivedAt.toISOString(),
    replayOfId: delivery.replayOfId,
    replayable: delivery.encryptedBody !== null,
  };
}

function principalOf(req: FastifyRequest): RequestPrincipal | undefined {
  return (req as FastifyRequest & { principal?: RequestPrincipal }).principal;
}

export function registerDeliveryRoutes(app: FastifyInstance, deps: DeliveryRouteDeps): void {
  const newId = deps.newDeliveryId ?? (() => crypto.randomUUID());

  app.get(
    "/api/v1/integrations/deliveries/dead-letter",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description:
          "List webhook deliveries that exhausted their attempts or could never be normalized.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: { limit: { type: "number", minimum: 1, maximum: 200 } },
        },
        response: {
          200: {
            type: "object",
            required: ["deliveries"],
            properties: { deliveries: { type: "array", items: DeliverySchema } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      if (!principal) return reply.code(401).send({ error: "authentication required" });

      const allowed = await deps.authorizationCheck(principal, {
        action: "integration.delivery.read",
        resourceType: "integration.delivery",
        fallback: "admin",
      });
      if (!allowed) return reply.code(403).send({ error: "not authorized to read deliveries" });

      const { limit } = req.query as { limit?: number };
      const rows = await deps.inbox.listDeadLettered(principal.businessId, limit ?? 50);
      return reply.code(200).send({ deliveries: rows.map(summarize) });
    }
  );

  app.post(
    "/api/v1/integrations/deliveries/:id/replay",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description:
          "Run a stored webhook delivery again as a new delivery that names the original.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
        },
        response: {
          201: DeliverySchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      if (!principal) return reply.code(401).send({ error: "authentication required" });

      const allowed = await deps.authorizationCheck(principal, {
        action: "integration.delivery.replay",
        resourceType: "integration.delivery",
        fallback: "admin",
      });
      if (!allowed) return reply.code(403).send({ error: "not authorized to replay a delivery" });

      const { id } = req.params as { id: string };
      const original = await deps.inbox.findById(principal.businessId, id);
      if (!original) return reply.code(404).send({ error: "delivery not found" });
      if (original.encryptedBody === null) {
        return reply.code(409).send({
          error:
            "That delivery can no longer be replayed: its payload passed the retention window and was discarded.",
        });
      }

      const replayed = await deps.inbox.replay(principal.businessId, id, newId());
      if (!replayed) return reply.code(404).send({ error: "delivery not found" });

      await deps.audit?.(req, "integration.delivery.replay", `delivery:${replayed.id}`, {
        replayOf: original.id,
        integrationId: original.integrationId,
        eventType: original.eventType,
      });
      return reply.code(201).send(summarize(replayed));
    }
  );
}
