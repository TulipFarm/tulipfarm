import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { IngressDeliveriesRepo } from "./repo";
import { verifySlackSignature } from "./signature";

/** One accepted delivery, queued for the integration-ingress pg-boss worker. */
export interface IngressJobPayload {
  slug: string;
  protocol: "slack";
  body: Record<string, unknown>;
}

export interface IngressRoutesDeps {
  soulLoader: SoulLoader;
  deliveries: IngressDeliveriesRepo;
  enqueue: (job: IngressJobPayload) => Promise<void>;
}

const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SLACK_SIGNATURE_HEADER = "x-slack-signature";

/** Constant 404 body: never reveal whether the integration exists / is connected / declares ingress. */
const NOT_FOUND = { error: "integration ingress not found" };

/**
 * Generic integration ingress hook — NO session auth, NO CSRF (mirrors the routines webhook
 * seam). Registered in its own Fastify plugin scope so the JSON content-type parser can capture
 * the raw body (`parseAs: "buffer"`) for HMAC verification without affecting any other route.
 * Does only cheap synchronous work (verify → challenge → dedup → enqueue) and acks inside
 * Slack's 3-second window; all real processing happens on the pg-boss worker.
 */
export async function registerIngressRoutes(
  app: FastifyInstance,
  deps: IngressRoutesDeps
): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body)
    );

    scope.post(
      "/api/v1/hooks/integrations/:name",
      {
        schema: {
          description:
            "Inbound webhook receiver for an installed integration. Signature-verified per the " +
            "integration manifest's ingress config (built-in protocols: slack). Answers the " +
            "provider's URL-verification challenge, dedups retries, and queues the event for " +
            "async processing (chat injection or integration.event).",
          tags: ["ingress"],
          params: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string", minLength: 1 } },
          },
          response: {
            200: {
              type: "object",
              additionalProperties: false,
              properties: { challenge: { type: "string" } },
            },
            401: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        const integration = deps.soulLoader.integrations.get(name);
        if (!integration) return reply.code(404).send(NOT_FOUND);

        const ingress = integration.manifest.ingress;
        const webhook = ingress && ingress.type !== "none" ? ingress.webhook : undefined;
        if (webhook?.verification_protocol !== "slack") {
          return reply.code(404).send(NOT_FOUND);
        }
        const connection = integration.connection;
        if (!connection?.enabled) return reply.code(404).send(NOT_FOUND);

        const security = webhook.security;
        if (security?.type !== "hmac_sha256") {
          // V1 posture matches the routines webhook: never open. An ingress block without
          // hmac security is a manifest bug, not a reason to accept unsigned traffic.
          return reply.code(401).send({ error: "webhook security not configured" });
        }
        const secret = connection.env?.[security.secret_env];
        if (!secret) return reply.code(401).send({ error: "webhook secret not configured" });

        const raw = req.body as Buffer;
        const check = verifySlackSignature(
          raw,
          headerValue(req.headers[SLACK_TIMESTAMP_HEADER]),
          headerValue(req.headers[SLACK_SIGNATURE_HEADER]),
          secret
        );
        if (!check.ok) {
          req.log.warn({ integration: name, reason: check.reason }, "ingress signature rejected");
          return reply.code(401).send({ error: "invalid signature" });
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          return reply.code(401).send({ error: "invalid payload" });
        }

        // Slack URL verification (Event Subscriptions setup) — signed like any other request.
        if (body.type === "url_verification") {
          return reply.code(200).send({ challenge: String(body.challenge ?? "") });
        }
        if (body.type !== "event_callback") return reply.code(200).send({});

        // Retry dedup: Slack resends the same event_id (X-Slack-Retry-Num); first delivery wins.
        const eventId = typeof body.event_id === "string" ? body.event_id : undefined;
        if (eventId) {
          const first = await deps.deliveries.recordDelivery(name, eventId);
          if (!first) return reply.code(200).send({});
        }

        await deps.enqueue({ slug: name, protocol: "slack", body });
        return reply.code(200).send({});
      }
    );
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
