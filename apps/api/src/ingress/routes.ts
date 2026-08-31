import type { BundledIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { isSecretRef } from "../integrations/connection-env";
import { resolveIngressIntegration } from "../integrations/ingress-integration";
import type { IngressDeliveriesRepo } from "./repo";
import { verifyWebhookRequest } from "./signature";
import { dotPath, matchesBody, renderBodyTemplate } from "./template";

export interface IngressJobPayload {
  slug: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface IngressRoutesDeps {
  soulLoader: SoulLoader;
  /** Bundled (code-owned) integrations, merged with live Soul connection state per delivery. */
  bundled: ReadonlyMap<string, BundledIntegration>;
  deliveries: IngressDeliveriesRepo;
  invoke: (job: IngressJobPayload) => Promise<void>;
  /** Resolves a `secret://` env value to plaintext; plaintext values need no resolver. */
  resolveSecret?: (value: string) => Promise<string | undefined>;
}

/** Constant 404 body: never reveal integration existence, connection, or ingress support. */
const NOT_FOUND = { error: "integration ingress not found" };

/**
 * Generic integration ingress hook — NO session auth, NO CSRF (mirrors the routines webhook seam),
 * and NO provider-specific code: verification, handshake, accept filtering, and dedup are all
 * driven by the integration manifest's declarative `ingress.webhook` block. Registered in its own
 * Fastify plugin scope so the JSON content-type parser can capture the raw body (`parseAs:
 * "buffer"`) for HMAC verification without affecting any other route. Does only cheap synchronous
 * work (verify → handshake → dedup → persist) and acks inside the provider's acknowledgement
 * window; all real processing is claimed from the durable Run store.
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
            "Inbound webhook receiver for an installed integration. Signature-verified, " +
            "challenge-answered, and deduped per the integration manifest's declarative " +
            "ingress config; accepted deliveries create a durable Integration Run before the " +
            "request is acknowledged.",
          tags: ["ingress"],
          params: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string", minLength: 1 } },
          },
          response: {
            200: { type: "object", additionalProperties: true },
            401: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const { name } = req.params as { name: string };
        const integration = resolveIngressIntegration(deps.soulLoader, deps.bundled, name);
        if (!integration) return reply.code(404).send(NOT_FOUND);

        const ingress = integration.manifest?.ingress;
        if (!ingress?.webhook || !ingress.handler || !integration.ingressHandler) {
          // Never reveal in the response that `name` names a real, installed integration — but
          // a delivery arriving for one that genuinely has no ingress support is an operator
          // misconfiguration (a stale provider-side webhook URL, most likely), not a scan. Log it
          // so it is visible in server logs even though the response must stay a generic 404.
          req.log.warn({ integration: name }, "ingress delivery received but no ingress declared");
          return reply.code(404).send(NOT_FOUND);
        }
        const connection = integration.connection;
        if (!connection?.enabled) {
          req.log.warn(
            { integration: name },
            "ingress delivery received but the integration is not connected"
          );
          return reply.code(404).send(NOT_FOUND);
        }

        const security = ingress.webhook.security;
        if (security?.type !== "hmac_sha256" && security?.type !== "shared_secret") {
          // V1 posture matches the routines webhook: never open. An ingress block without a
          return reply.code(401).send({ error: "webhook security not configured" });
        }
        let secret = connection.env?.[security.secret_env];
        if (secret && isSecretRef(secret)) {
          secret = deps.resolveSecret ? await deps.resolveSecret(secret) : undefined;
        }
        if (!secret) return reply.code(401).send({ error: "webhook secret not configured" });

        const raw = req.body as Buffer;
        const check = verifyWebhookRequest(raw, req.headers, security, secret);
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

        const handshake = ingress.webhook.handshake;
        if (handshake && matchesBody(body, handshake.match)) {
          const respond: Record<string, string> = {};
          for (const [key, template] of Object.entries(handshake.respond)) {
            respond[key] = renderBodyTemplate(template, body);
          }
          return reply.code(200).send(respond);
        }

        if (!matchesBody(body, ingress.webhook.accept)) return reply.code(200).send({});

        // Provider-retry dedup: a declared header (e.g. X-GitHub-Delivery) wins over the body
        const dedupValue = ingress.webhook.dedup_header
          ? headerValue(req.headers, ingress.webhook.dedup_header)
          : ingress.webhook.dedup_key
            ? dotPath(body, ingress.webhook.dedup_key)
            : undefined;
        if (typeof dedupValue === "string" && dedupValue) {
          const first = await deps.deliveries.recordDelivery(name, dedupValue);
          if (!first) return reply.code(200).send({});
        }

        let headers: Record<string, string> | undefined;
        if (ingress.webhook.context_headers?.length) {
          headers = {};
          for (const name_ of ingress.webhook.context_headers) {
            const value = headerValue(req.headers, name_);
            if (value !== undefined) headers[name_.toLowerCase()] = value;
          }
        }

        await deps.invoke({ slug: name, body, headers });
        return reply.code(200).send({});
      }
    );
  });
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}
