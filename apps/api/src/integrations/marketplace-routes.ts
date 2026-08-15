import type { BundledIntegration, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import {
  ALLOWED_SOURCE_HINT,
  isAllowedSource,
  isSoulWriteError,
  soulWriteHttpError,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { commitActorFromRequest } from "../soul/commit-actor";
import {
  IntegrationInstallError,
  inspectIntegrationSource,
  installIntegrationFromSource,
} from "./install";

/* Installing curated integrations uses the same clone/validate/write path as a pasted repo URL. */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

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
  },
} as const;

export function registerIntegrationMarketplaceRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  soulWriter: SoulWriter,
  bundled: ReadonlyMap<string, BundledIntegration>,
  requireAuth: PreHandler
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
        },
      },
    },
    async (req, reply) => {
      const { source } = req.body as { source: string };
      if (!isAllowedSource(source)) {
        return reply.code(400).send({ error: ALLOWED_SOURCE_HINT });
      }
      try {
        const { ref, integrations } = await inspectIntegrationSource(source);
        const bundledNames = bundledSlugs();
        return {
          source,
          ref,
          integrations: integrations.map((entry) => ({
            name: entry.name,
            description: entry.manifest.description,
            version: entry.manifest.version,
            maintainer: entry.manifest.maintainer,
            installed: bundledNames.has(entry.name) || soulLoader.integrations.has(entry.name),
            installable: entry.issues.length === 0,
            issues: entry.issues,
          })),
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
      preHandler: requireAuth,
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
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { source, name } = req.body as { source: string; name?: string };
      if (!isAllowedSource(source)) {
        return reply.code(400).send({ error: ALLOWED_SOURCE_HINT });
      }
      try {
        return await installIntegrationFromSource(
          { source, name },
          {
            soulLoader,
            soulWriter,
            bundledSlugs: bundledSlugs(),
            actor: commitActorFromRequest(req),
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
}
