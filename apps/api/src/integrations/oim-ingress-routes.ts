import { type ReceiveDeliveryDeps, receiveDelivery } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { FastifyInstance } from "fastify";
import { ErrorSchema } from "../auth/schemas";

/**
 * The OIM webhook receiver.
 *
 * Session auth and CSRF do not apply: the caller is a provider holding a signing Secret, not a
 * person holding a cookie. Registered in its own plugin scope so the raw body can be captured for
 * signature verification without changing how any other route parses JSON.
 */

export interface OimIngressRouteDeps extends Omit<ReceiveDeliveryDeps, "newDeliveryId"> {
  /** Resolves the installed Integration and the business that installed it, or null. */
  readonly resolve: (
    slug: string
  ) => Promise<{ readonly businessId: string; readonly manifest: OimManifest } | null>;
  /** Resolves the exact public callback URL registered with the provider from trusted config. */
  readonly callbackUrl?: (slug: string, connectionId?: string) => string;
  readonly newDeliveryId?: () => string;
}

/**
 * One body for every outcome that is not a handshake.
 *
 * A provider learns only that the request was received. Distinguishing "no such Integration" from
 * "bad signature" would let anyone map which Integrations an instance has installed by watching
 * which slugs answer differently.
 */
const ACKNOWLEDGED = { received: true };

export async function registerOimIngressRoutes(
  app: FastifyInstance,
  deps: OimIngressRouteDeps
): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body)
    );
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body)
    );

    scope.post(
      "/api/v1/hooks/oim/:slug",
      {
        schema: {
          description:
            "Inbound webhook receiver for an installed Open Integration Manifest Integration. " +
            "The delivery is verified against the manifest's declared verification scheme, " +
            "filtered by its declared acceptance rules, deduplicated, and persisted durably " +
            "before this route acknowledges it.",
          tags: ["ingress"],
          params: {
            type: "object",
            required: ["slug"],
            properties: { slug: { type: "string", minLength: 1, maxLength: 128 } },
          },
          querystring: {
            type: "object",
            properties: { connectionId: { type: "string", minLength: 1, maxLength: 256 } },
          },
          response: {
            200: {
              oneOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
            },
            401: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const { slug } = req.params as { slug: string };
        const { connectionId } = req.query as { connectionId?: string };
        const acknowledge = () =>
          slug === "twilio"
            ? reply.code(200).type("application/xml").send("<Response></Response>")
            : reply.code(200).send(ACKNOWLEDGED);
        const installed = await deps.resolve(slug);
        if (!installed) {
          req.log.warn(
            { integration: slug },
            "OIM delivery for an Integration that is not installed"
          );
          return acknowledge();
        }

        const result = await receiveDelivery(
          {
            businessId: installed.businessId,
            manifest: installed.manifest,
            rawBody: req.body as Buffer,
            headers: req.headers,
            ...(connectionId === undefined ? {} : { connectionId }),
            ...(deps.callbackUrl === undefined
              ? {}
              : { callbackUrl: deps.callbackUrl(slug, connectionId) }),
          },
          { ...deps, newDeliveryId: deps.newDeliveryId ?? (() => crypto.randomUUID()) }
        );

        switch (result.kind) {
          case "handshake":
            return reply.code(200).send(result.body);
          case "accepted":
            // The row is durable, so the acknowledgement is a promise this instance can keep.
            req.log.info(
              { integration: slug, delivery: result.deliveryId, duplicate: result.duplicate },
              "OIM delivery accepted"
            );
            return acknowledge();
          case "discarded":
            req.log.debug({ integration: slug, reason: result.reason }, "OIM delivery discarded");
            return acknowledge();
          case "unverified":
            // The one case worth telling the caller about: a provider whose signing Secret has
            // been rotated needs to see a failure rather than a silent success.
            req.log.warn(
              { integration: slug, reason: result.reason },
              "OIM delivery failed verification"
            );
            return reply.code(401).send({ error: "invalid signature" });
          default:
            req.log.warn(
              { integration: slug, reason: result.reason },
              "OIM delivery could not be received"
            );
            return acknowledge();
        }
      }
    );
  });
}
