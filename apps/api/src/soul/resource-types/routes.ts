import { existsSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { ajv, TulipFarmValidationError, validateResourceSchema } from "@tulipfarm/validation";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ErrorSchema } from "../../auth/schemas";
import { analyzeHook, HookAnalysisError } from "../../hooks/hook-analyzer.js";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NAME_RE = /^[a-z][a-z0-9-]*$/;

type SchemaCheck =
  | { ok: true; parsed: Record<string, unknown> }
  | { ok: false; status: 422; body: { error: string; boundary?: string; path?: string } };

// Shared schema gate for create/update: parse YAML → JSON Schema meta-validate → x-* whitelist
// (VAL-V1-009 1-pass). Returns the parsed object or the exact error response to send.
function checkSchemaYaml(schemaYaml: string): SchemaCheck {
  let parsed: unknown;
  try {
    parsed = parseYaml(schemaYaml);
  } catch (err) {
    return {
      ok: false,
      status: 422,
      body: { error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 422,
      body: { error: "schema must be a YAML object (JSON Schema)" },
    };
  }
  if (!ajv.validateSchema(parsed)) {
    const e = ajv.errors?.[0];
    return {
      ok: false,
      status: 422,
      body: { error: e?.message ?? "invalid JSON Schema", path: e?.instancePath ?? "" },
    };
  }
  try {
    validateResourceSchema(parsed as Record<string, unknown>);
  } catch (err) {
    if (err instanceof TulipFarmValidationError) {
      return {
        ok: false,
        status: 422,
        body: { error: err.message, boundary: err.boundary, path: err.path },
      };
    }
    throw err;
  }
  return { ok: true, parsed: parsed as Record<string, unknown> };
}

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

      const check = checkSchemaYaml(schemaYaml);
      if (!check.ok) return reply.code(check.status).send(check.body);

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

  app.put(
    "/api/v1/resource-types/:name",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Replace an existing resource type's schema. `schema` is a YAML string (JSON Schema).",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        body: {
          type: "object",
          required: ["schema"],
          properties: { schema: { type: "string" } },
        },
        response: {
          200: ResourceTypeSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          422: ValidationErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const { schema: schemaYaml } = req.body as { schema: string };

      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      const typeDir = join(gitSync.path, "resources", name);
      if (!existsSync(typeDir)) {
        return reply.code(404).send({ error: "resource type not found" });
      }
      const check = checkSchemaYaml(schemaYaml);
      if (!check.ok) return reply.code(check.status).send(check.body);

      await writeFile(join(typeDir, "schema.yml"), schemaYaml, "utf8");
      await gitSync.commit(`soul: update resource type ${name}`);
      await soulLoader.reload();
      // New columns may have been added — materialise them before records reference them.
      await reconcile?.();

      const reloaded = soulLoader.resources.get(name);
      return reply
        .code(200)
        .send({ name, schema: schemaYaml, hasHooks: reloaded?.hasHooks ?? false });
    }
  );

  app.delete(
    "/api/v1/resource-types/:name",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Remove a resource type definition from the soul. The Postgres table is left intact " +
          "(non-destructive) so existing records remain recoverable.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: { 204: { type: "null" }, 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      const typeDir = join(gitSync.path, "resources", name);
      if (!existsSync(typeDir)) {
        return reply.code(404).send({ error: "resource type not found" });
      }
      await rm(typeDir, { recursive: true, force: true });
      await gitSync.commit(`soul: remove resource type ${name}`);
      await soulLoader.reload();
      return reply.code(204).send();
    }
  );

  // ── Hook routes ───────────────────────────────────────────────────────────

  const HookResponseSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      hasHooks: { type: "boolean" },
      source: { type: "string", nullable: true },
    },
    required: ["name", "hasHooks"],
  } as const;

  app.get(
    "/api/v1/resource-types/:name/hooks",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get the hooks.ts source for a resource type, or null if none exists.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: { 200: HookResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const rt = soulLoader.resources.get(name);
      if (!rt) return reply.code(404).send({ error: `resource type not found: ${name}` });
      return reply.send({ name, hasHooks: rt.hasHooks, source: rt.hookSource ?? null });
    }
  );

  app.put(
    "/api/v1/resource-types/:name/hooks",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Create or replace the hooks.ts file for a resource type. " +
          "Runs static analysis to block banned patterns.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        body: {
          type: "object",
          required: ["source"],
          properties: { source: { type: "string" } },
        },
        response: {
          200: HookResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          422: ValidationErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const { source } = req.body as { source: string };

      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      if (!soulLoader.resources.has(name)) {
        return reply.code(404).send({ error: `resource type not found: ${name}` });
      }

      try {
        analyzeHook(source);
      } catch (hookErr) {
        if (hookErr instanceof HookAnalysisError) {
          return reply.code(422).send({ error: hookErr.message });
        }
        throw hookErr;
      }

      const trimmed = source.trim();
      if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
        return reply.code(422).send({
          error: "hook source must be a parenthesized object literal: `({ before(ctx) { ... } })`",
        });
      }

      const hooksFile = join(gitSync.path, "resources", name, "hooks.ts");
      await writeFile(hooksFile, source, "utf8");
      await gitSync.commit(`soul: add hooks for resource type ${name}`);
      await soulLoader.reload();

      return reply.send({ name, hasHooks: true, source });
    }
  );

  app.delete(
    "/api/v1/resource-types/:name/hooks",
    {
      preHandler: requireAuth,
      schema: {
        description: "Remove the hooks.ts file for a resource type.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      if (!soulLoader.resources.has(name)) {
        return reply.code(404).send({ error: `resource type not found: ${name}` });
      }

      const hooksFile = join(gitSync.path, "resources", name, "hooks.ts");
      if (!existsSync(hooksFile)) {
        return reply.code(404).send({ error: `no hooks found for resource type: ${name}` });
      }

      await unlink(hooksFile);
      await gitSync.commit(`soul: remove hooks for resource type ${name}`);
      await soulLoader.reload();
      return reply.code(204).send();
    }
  );
}
