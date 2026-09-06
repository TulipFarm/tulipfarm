import { describeOimCapabilities } from "@tulipfarm/integrations";
import type { BundledIntegration, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { isSoulWriteError, soulWriteHttpError } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import { commitActorFromRequest } from "../soul/commit-actor";
import {
  IntegrationInstallError,
  inspectIntegrationSource,
  installIntegrationFromSource,
  updateIntegrationFromSource,
} from "./install";

/* Installing curated integrations uses the same clone/validate/write path as a pasted repo URL. */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * What installing an OIM package would grant, derived from the manifest being inspected.
 *
 * Declared in full rather than left open: Fastify serializes to the schema, so an undeclared
 * property is silently dropped, and a capability a reviewer never sees is one they cannot refuse.
 */
const CapabilityReviewSchema = {
  type: "object",
  required: ["integrationId", "version", "packageDigest", "destinations", "operations"],
  properties: {
    integrationId: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    license: { type: "string" },
    maintainers: { type: "array", items: { type: "string" } },
    packageDigest: { type: "string" },
    destinations: { type: "array", items: { type: "string" } },
    allowedOriginHosts: { type: "array", items: { type: "string" } },
    credentialSlots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          kind: { type: "string" },
          required: { type: "boolean" },
        },
      },
    },
    configurationFields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          type: { type: "string" },
          agentVisible: { type: "boolean" },
        },
      },
    },
    identityModes: { type: "array", items: { type: "string" } },
    effects: { type: "array", items: { type: "string" } },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          effect: { type: "string" },
          mutating: { type: "boolean" },
          identityMode: { type: "string" },
          credentialSlot: { type: "string" },
          destination: { type: "string" },
        },
      },
    },
    ingress: {
      type: "object",
      properties: {
        path: { type: "string" },
        verification: { type: "string" },
        eventTypes: { type: "array", items: { type: "string" } },
        rawRetentionDays: { type: "integer" },
      },
    },
    knowledge: {
      type: "object",
      properties: {
        sourceKinds: { type: "array", items: { type: "string" } },
        propagatesDeletions: { type: "boolean" },
        liveAuthorization: { type: "boolean" },
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, role: { type: "string" } },
      },
    },
    fixtures: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "fixture", "passed"],
        properties: {
          name: { type: "string" },
          fixture: { type: "string" },
          passed: { type: "boolean" },
          error: { type: "string" },
        },
      },
    },
    declaresHooks: { type: "boolean" },
  },
} as const;

const DiscoveredSchema = {
  type: "object",
  required: ["name", "installable", "issues"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    version: { type: "string" },
    maintainer: { type: "string" },
    installed: { type: "boolean" },
    installable: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    definition: { type: "string", enum: ["oim", "legacy"] },
    support: { type: "string", enum: ["official", "community"] },
    license: { type: "string" },
    packageDigest: { type: "string" },
    fixtures: CapabilityReviewSchema.properties.fixtures,
    review: CapabilityReviewSchema,
  },
} as const;

export function registerIntegrationMarketplaceRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  soulWriter: SoulWriter,
  bundled: ReadonlyMap<string, BundledIntegration>,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  function bundledSlugs(): Set<string> {
    return new Set(bundled.keys());
  }

  app.post(
    "/api/v1/integrations/inspect",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Clone a git repo (source accepts an optional #branch suffix) and report the integrations it offers, without installing.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: { source: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["source", "ref", "integrations"],
            properties: {
              source: { type: "string" },
              ref: { type: "string" },
              integrations: { type: "array", items: DiscoveredSchema },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { source } = req.body as { source: string };
      try {
        const actorId = commitActorFromRequest(req).principalId;
        const { ref, integrations } = await inspectIntegrationSource(source, actorId);
        const bundledNames = bundledSlugs();
        return {
          source,
          ref,
          integrations: integrations.map((entry) => {
            const installed =
              bundledNames.has(entry.name) || soulLoader.integrations.has(entry.name);
            if (entry.oimManifest !== undefined) {
              const review = describeOimCapabilities(entry.oimManifest);
              return {
                name: entry.name,
                description: entry.oimManifest.metadata.description,
                version: review.version,
                // The review carries the maintainer list; this stays a single string so a client
                // written against the legacy shape keeps working.
                maintainer: review.maintainers[0],
                installed,
                installable: entry.issues.length === 0,
                issues: entry.issues,
                definition: "oim",
                // Every installable OIM package is Community today: nothing signs a release yet,
                // and labelling one "official" before a signature can prove it would be the
                // support claim this field exists to keep honest.
                support: "community",
                license: review.license,
                packageDigest: entry.packageDigest,
                fixtures: entry.fixtureResults,
                review,
              };
            }
            return {
              name: entry.name,
              description: entry.manifest?.description,
              version: entry.manifest?.version,
              maintainer: entry.manifest?.maintainer,
              installed,
              installable: entry.issues.length === 0,
              issues: entry.issues,
              definition: "legacy",
            };
          }),
        };
      } catch (error) {
        // Every failure here is a bad source: nothing can be missing or conflict until an install
        // is actually attempted, so inspect has no 404/409 to report.
        if (error instanceof IntegrationInstallError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  app.post(
    "/api/v1/integrations/install",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.install",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
      schema: {
        description:
          "Install a declarative integration from a git repo into the soul repo. `name` selects one when the repo offers several.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: {
            source: { type: "string", minLength: 1 },
            name: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["name", "source", "ref"],
            properties: {
              name: { type: "string" },
              source: { type: "string" },
              ref: { type: "string" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          429: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { source, name } = req.body as { source: string; name?: string };
      const actor = commitActorFromRequest(req);
      try {
        return await installIntegrationFromSource(
          { source, name },
          {
            soulLoader,
            soulWriter,
            bundledSlugs: bundledSlugs(),
            actor,
            actorId: actor.principalId,
          }
        );
      } catch (error) {
        if (error instanceof IntegrationInstallError) {
          return reply.code(error.status).send({ error: error.message });
        }
        if (isSoulWriteError(error)) {
          const mapped = soulWriteHttpError(error);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
    }
  );

  app.post(
    "/api/v1/integrations/:name/update",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.update",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
      schema: {
        description: "Update an installed integration from its source repository.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "string" },
            /** Required when an OIM package's digest changed since it was approved. */
            approve_digest: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["name", "source", "ref"],
            properties: {
              name: { type: "string" },
              source: { type: "string" },
              ref: { type: "string" },
              package_digest: { type: "string" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          429: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const { source, approve_digest: approveDigest } = (req.body ?? {}) as {
        source?: string;
        approve_digest?: string;
      };
      const actor = commitActorFromRequest(req);
      try {
        const result = await updateIntegrationFromSource(
          { source, name, approveDigest },
          {
            soulLoader,
            soulWriter,
            bundledSlugs: bundledSlugs(),
            actor,
            actorId: actor.principalId,
          }
        );
        return {
          name: result.name,
          source: result.source,
          ref: result.ref,
          ...(result.packageDigest === undefined ? {} : { package_digest: result.packageDigest }),
        };
      } catch (error) {
        if (error instanceof IntegrationInstallError) {
          return reply.code(error.status).send({ error: error.message });
        }
        if (isSoulWriteError(error)) {
          const mapped = soulWriteHttpError(error);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
    }
  );
}
