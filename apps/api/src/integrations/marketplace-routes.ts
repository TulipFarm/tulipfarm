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
  type OimInstallTrust,
  reviewOimTrust,
  updateIntegrationFromSource,
} from "./install";
import { oimManifestMajor, resolveOimMajorArtifact } from "./oim-major-versions";

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
    installed_slug: { type: "string" },
    major_version: { type: "integer" },
    installable: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    definition: { type: "string", enum: ["oim", "legacy"] },
    support: { type: "string", enum: ["official", "community"] },
    hooks_allowed: { type: "boolean" },
    auto_patch_eligible: { type: "boolean" },
    verified_signer_key_id: { type: "string" },
    revocation_sequence: { type: "integer", minimum: 0 },
    license: { type: "string" },
    package_digest: { type: "string" },
    fixtures: CapabilityReviewSchema.properties.fixtures,
    review: CapabilityReviewSchema,
  },
} as const;

const SignedReleaseSchema = {
  type: "object",
  required: ["envelopeVersion", "release", "signature"],
  additionalProperties: false,
  properties: {
    envelopeVersion: { type: "integer", const: 1 },
    release: {
      type: "object",
      required: ["integrationId", "version", "packageDigest"],
      additionalProperties: false,
      properties: {
        integrationId: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        packageDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
    signature: {
      type: "object",
      required: ["algorithm", "keyId", "value"],
      additionalProperties: false,
      properties: {
        algorithm: { type: "string", const: "Ed25519" },
        keyId: { type: "string", minLength: 1 },
        value: { type: "string", minLength: 1 },
      },
    },
  },
} as const;

export function registerIntegrationMarketplaceRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  soulWriter: SoulWriter,
  bundled: ReadonlyMap<string, BundledIntegration>,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  releaseTrust?: OimInstallTrust
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
          "Inspect a git repository or direct HTTPS oim.yml URL and report the integrations it offers, without installing.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: {
            source: { type: "string", minLength: 1 },
            signed_release: SignedReleaseSchema,
          },
        },
        response: {
          200: {
            type: "object",
            required: ["source", "source_type", "ref", "integrations"],
            properties: {
              source: { type: "string" },
              source_type: { type: "string", enum: ["github", "git", "https"] },
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
      const { source, signed_release: signedRelease } = req.body as {
        source: string;
        signed_release?: unknown;
      };
      try {
        const actorId = commitActorFromRequest(req).principalId;
        const inspection = await inspectIntegrationSource(source, actorId);
        const { ref, integrations } = inspection;
        const bundledNames = bundledSlugs();
        return {
          source: inspection.source,
          source_type: inspection.sourceType,
          ref,
          integrations: await Promise.all(
            integrations.map(async (entry) => {
              if (entry.oimManifest !== undefined) {
                const manifest = entry.oimManifest;
                const artifact = resolveOimMajorArtifact(soulLoader.integrations.values(), {
                  id: manifest.metadata.id,
                  majorVersion: oimManifestMajor(manifest),
                });
                const review = describeOimCapabilities(manifest);
                const trust = await reviewOimTrust(entry, signedRelease, releaseTrust);
                return {
                  name: entry.name,
                  description: manifest.metadata.description,
                  version: review.version,
                  // The review carries the maintainer list; this stays a single string so a client
                  // written against the legacy shape keeps working.
                  maintainer: review.maintainers[0],
                  installed: bundledNames.has(entry.name) || artifact !== undefined,
                  ...(artifact === undefined ? {} : { installed_slug: artifact.slug }),
                  major_version: oimManifestMajor(manifest),
                  installable: trust.issues.length === 0,
                  issues: trust.issues,
                  definition: "oim",
                  support: trust.support,
                  hooks_allowed: trust.hooksAllowed,
                  auto_patch_eligible: trust.autoPatchEligible,
                  ...(trust.signerKeyId === undefined
                    ? {}
                    : { verified_signer_key_id: trust.signerKeyId }),
                  ...(trust.revocationSequence === undefined
                    ? {}
                    : { revocation_sequence: trust.revocationSequence }),
                  license: review.license,
                  package_digest: entry.packageDigest,
                  fixtures: entry.fixtureResults,
                  review,
                };
              }
              const installed =
                bundledNames.has(entry.name) || soulLoader.integrations.has(entry.name);
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
            })
          ),
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
          "Install a declarative integration from Git or HTTPS. OIM installs require the exact ref and digest returned by inspection.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: {
            source: { type: "string", minLength: 1 },
            name: { type: "string" },
            ref: {
              type: "string",
              description: "Opaque source reference returned by the inspect endpoint.",
            },
            approve_digest: {
              type: "string",
              description: "Exact OIM package digest returned by the inspect endpoint.",
            },
            signed_release: SignedReleaseSchema,
            auto_patch_opt_in: {
              type: "boolean",
              description:
                "Official releases enable compatible patch updates by default; set false to opt out. Community releases cannot opt in.",
            },
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
              integration_id: { type: "string" },
              major_version: { type: "integer" },
              support: { type: "string", enum: ["official", "community"] },
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
      const {
        source,
        name,
        ref,
        approve_digest: approveDigest,
        signed_release: signedRelease,
        auto_patch_opt_in: autoPatchOptIn,
      } = req.body as {
        source: string;
        name?: string;
        ref?: string;
        approve_digest?: string;
        signed_release?: unknown;
        auto_patch_opt_in?: boolean;
      };
      const actor = commitActorFromRequest(req);
      try {
        const result = await installIntegrationFromSource(
          { source, name, ref, approveDigest, signedRelease, autoPatchOptIn },
          {
            soulLoader,
            soulWriter,
            bundledSlugs: bundledSlugs(),
            actor,
            actorId: actor.principalId,
            releaseTrust,
          }
        );
        return {
          name: result.name,
          source: result.source,
          ref: result.ref,
          ...(result.packageDigest === undefined ? {} : { package_digest: result.packageDigest }),
          ...(result.integrationId === undefined ? {} : { integration_id: result.integrationId }),
          ...(result.majorVersion === undefined ? {} : { major_version: result.majorVersion }),
          ...(result.support === undefined ? {} : { support: result.support }),
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
        description: "Update an installed integration from its reviewed Git or HTTPS source.",
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
            ref: {
              type: "string",
              description: "Opaque source reference returned with the reviewed update.",
            },
            /** Required when an OIM package's digest changed since it was approved. */
            approve_digest: {
              type: "string",
              description: "Exact changed OIM package digest returned by inspection.",
            },
            signed_release: SignedReleaseSchema,
            auto_patch_opt_in: {
              type: "boolean",
              description:
                "Official releases preserve their patch preference; set false to opt out or true to opt back in. Community releases cannot opt in.",
            },
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
              integration_id: { type: "string" },
              major_version: { type: "integer" },
              support: { type: "string", enum: ["official", "community"] },
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
      const {
        source,
        ref,
        approve_digest: approveDigest,
        signed_release: signedRelease,
        auto_patch_opt_in: autoPatchOptIn,
      } = (req.body ?? {}) as {
        source?: string;
        ref?: string;
        approve_digest?: string;
        signed_release?: unknown;
        auto_patch_opt_in?: boolean;
      };
      const actor = commitActorFromRequest(req);
      try {
        const result = await updateIntegrationFromSource(
          { source, name, ref, approveDigest, signedRelease, autoPatchOptIn },
          {
            soulLoader,
            soulWriter,
            bundledSlugs: bundledSlugs(),
            actor,
            actorId: actor.principalId,
            releaseTrust,
          }
        );
        return {
          name: result.name,
          source: result.source,
          ref: result.ref,
          ...(result.packageDigest === undefined ? {} : { package_digest: result.packageDigest }),
          ...(result.integrationId === undefined ? {} : { integration_id: result.integrationId }),
          ...(result.majorVersion === undefined ? {} : { major_version: result.majorVersion }),
          ...(result.support === undefined ? {} : { support: result.support }),
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
