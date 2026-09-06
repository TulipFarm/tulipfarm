import { runOimFixtures } from "@tulipfarm/integrations";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const FixtureResultSchema = {
  type: "object",
  required: ["name", "fixture", "passed"],
  properties: {
    name: { type: "string" },
    fixture: { type: "string" },
    passed: { type: "boolean" },
    error: { type: "string" },
  },
} as const;

/** Runs an installed OIM package's self-contained fixtures through a recording transport. */
export function registerOimFixtureRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  requireAuth: PreHandler
): void {
  app.post(
    "/api/v1/integrations/:name/fixtures",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Run an installed OIM package's offline fixtures without network, clock, or credential access.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["fixtures"],
            properties: { fixtures: { type: "array", items: FixtureResultSchema } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const integration = soulLoader.integrations.get(name);
      const manifest = integration?.oimManifest;
      if (manifest === undefined) {
        return reply.code(404).send({ error: `OIM integration not found: ${name}` });
      }
      const companions = new Map([
        ...Object.entries(integration?.oimDocuments ?? {}),
        ...Object.entries(integration?.oimFixtures ?? {}),
      ]);
      return { fixtures: await runOimFixtures(manifest, companions) };
    }
  );
}
