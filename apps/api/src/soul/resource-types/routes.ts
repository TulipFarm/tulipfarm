import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { TulipFarmValidationError, ajv, validateResourceSchema } from "@tulipfarm/validation";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ErrorSchema } from "../../auth/schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NAME_RE = /^[a-z][a-z0-9-]*$/;

const ValidationErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    boundary: { type: "string" },
    path: { type: "string" },
  },
  required: ["error"],
} as const;

const ResourceTypeSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    schema: { type: "string" },
    hasHooks: { type: "boolean" },
  },
  required: ["name", "schema", "hasHooks"],
} as const;

export function registerResourceTypeRoutes(
  app: FastifyInstance,
  gitSync: GitSyncService,
  soulLoader: SoulLoader,
  requireAuth: PreHandler,
  reconcile?: () => Promise<void>
): void {
  app.post(
    "/api/v1/resource-types",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Create a new resource type. `schema` is a YAML string (JSON Schema). Written as-is to soul/resources/{name}/schema.yml.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["name", "schema"],
          properties: {
            name: { type: "string" },
            schema: { type: "string" },
          },
        },
        response: {
          201: ResourceTypeSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          409: ErrorSchema,
          422: ValidationErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name, schema: schemaYaml } = req.body as { name: string; schema: string };

      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }

      const typeDir = join(gitSync.path, "resources", name);
      if (existsSync(typeDir)) {
        return reply.code(409).send({ error: "resource type already exists" });
      }

      // Parse YAML
      let parsed: unknown;
      try {
        parsed = parseYaml(schemaYaml);
      } catch (err) {
        return reply.code(422).send({
          error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return reply.code(422).send({ error: "schema must be a YAML object (JSON Schema)" });
      }

      // JSON Schema meta-validation
      const validMeta = ajv.validateSchema(parsed);
      const metaErrors = ajv.errors;
      if (!validMeta) {
        const e = metaErrors?.[0];
        return reply.code(422).send({
          error: e?.message ?? "invalid JSON Schema",
          path: e?.instancePath ?? "",
        });
      }

      // x-* whitelist check (VAL-V1-009 1-pass)
      try {
        validateResourceSchema(parsed as Record<string, unknown>);
      } catch (err) {
        if (err instanceof TulipFarmValidationError) {
          return reply
            .code(422)
            .send({ error: err.message, boundary: err.boundary, path: err.path });
        }
        throw err;
      }

      await mkdir(typeDir, { recursive: true });
      await writeFile(join(typeDir, "schema.yml"), schemaYaml, "utf8");

      await gitSync.commit(`soul: add resource type ${name}`);
      await soulLoader.reload();
      // Materialise the new type's Postgres table before the client can POST records to it.
      await reconcile?.();

      return reply.code(201).send({ name, schema: schemaYaml, hasHooks: false });
    }
  );

  app.get(
    "/api/v1/resource-types",
    {
      preHandler: requireAuth,
      schema: {
        description: "List all resource types. Each `schema` field is a YAML string.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              types: { type: "array", items: ResourceTypeSchema },
            },
            required: ["types"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const types = Array.from(soulLoader.resources.values()).map(({ name, schema, hasHooks }) => ({
        name,
        schema: stringifyYaml(schema),
        hasHooks,
      }));
      return reply.send({ types });
    }
  );
}
