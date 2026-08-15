import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { analyzeHook, HookAnalysisError } from "@tulipfarm/sandbox";
import { ajv, TulipFarmValidationError, validateResourceSchema } from "@tulipfarm/schema";
import type { SoulLoader, SoulWrite, SoulWriter } from "@tulipfarm/soul";
import {
  isSoulWriteError,
  RESOURCE_DOMAIN_RE,
  resourceDefinitionYaml,
  resourceEnvelopeError,
  resourceTypePayload,
  soulWriteHttpError,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse as parseYaml } from "yaml";
import type { AuditService } from "../../audit/service";
import { makeSoulAuditWriter } from "../../audit/soul-write";
import { ErrorSchema } from "../../auth/schemas";
import type { AuthorizationCheck, RouteAuthorization } from "../../authz/route-gate";
import type { RateLimiter } from "../../rate-limit";
import { makeRateLimitHook } from "../../rate-limit";
import { commitActorFromRequest } from "../commit-actor";
import {
  CreateResourceTypeBodySchema,
  ListResourceTypesResponseSchema,
  ResourceTypeDeleteResponseSchema,
  ResourceTypeHooksDeleteResponseSchema,
  ResourceTypeHooksResponseSchema,
  ResourceTypeNameParamsSchema,
  ResourceTypeResponseSchema,
  ResourceTypeValidationErrorSchema,
  UpdateResourceTypeBodySchema,
  UpdateResourceTypeHooksBodySchema,
} from "./schemas";

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

const SOUL_WRITE_LIMIT = 60;
const SOUL_WRITE_WINDOW_MS = 60_000;

/** Resource `domain` changes are the HR/engineering wall and require admin; schema edits do not. */
const SET_DOMAIN: RouteAuthorization = {
  action: "soul.resource_type.set_domain",
  resourceType: "soul.resource_type",
  fallback: "admin",
};
const DELETE_DOMAINED: RouteAuthorization = {
  action: "soul.resource_type.delete_domained",
  resourceType: "soul.resource_type",
  fallback: "admin",
};

export function registerResourceTypeRoutes(
  app: FastifyInstance,
  soulWriter: SoulWriter,
  soulPath: string,
  soulLoader: SoulLoader,
  requireAuth: PreHandler,
  authorizationCheck: AuthorizationCheck,
  reconcile?: () => Promise<void>,
  rateLimiter?: RateLimiter,
  audit?: AuditService
): void {
  const auditWrite = makeSoulAuditWriter(audit);
  const mayChangeDomain = async (req: FastifyRequest, decl: RouteAuthorization): Promise<boolean> =>
    req.principal !== undefined && (await authorizationCheck(req.principal, decl));
  const rateLimitHook = rateLimiter
    ? makeRateLimitHook(
        rateLimiter,
        (req) => `rl:soul:${req.ip}`,
        SOUL_WRITE_LIMIT,
        SOUL_WRITE_WINDOW_MS
      )
    : undefined;
  const writeHandlers: PreHandler[] = rateLimitHook ? [rateLimitHook, requireAuth] : [requireAuth];

  app.post(
    "/api/v1/resource-types",
    {
      preHandler: writeHandlers,
      schema: {
        description:
          "Create a new resource type. `schema` is a YAML string (JSON Schema). Written as-is to soul/resources/{name}/schema.yml.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: CreateResourceTypeBodySchema,
        response: {
          201: ResourceTypeResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ResourceTypeValidationErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const {
        name,
        schema: schemaYaml,
        domain,
      } = req.body as { name: string; schema: string; domain?: string };

      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      if (domain !== undefined && !RESOURCE_DOMAIN_RE.test(domain)) {
        return reply.code(400).send({ error: "invalid resource type domain" });
      }
      if (domain !== undefined && !(await mayChangeDomain(req, SET_DOMAIN))) {
        return reply.code(403).send({ error: "only an admin can set a resource type's domain" });
      }

      const typeDir = join(soulPath, "resources", name);
      if (existsSync(typeDir)) {
        return reply.code(409).send({ error: "resource type already exists" });
      }

      const check = checkSchemaYaml(schemaYaml);
      if (!check.ok) return reply.code(check.status).send(check.body);

      const body =
        domain === undefined
          ? schemaYaml
          : resourceDefinitionYaml({ name, schema: check.parsed, domain });
      if (domain !== undefined) {
        const envelopeError = resourceEnvelopeError(body);
        if (envelopeError !== undefined) {
          return reply.code(422).send({ error: envelopeError });
        }
      }

      try {
        await soulWriter.apply({
          subject: `soul: add resource type ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [
            {
              op: "put",
              // A domainless type keeps the superseded `schema.yml` spelling; only a domained one
              // needs the canonical envelope that carries the wall.
              target:
                domain === undefined
                  ? { kind: "Resource", slug: name, definitionMode: "legacy" }
                  : { kind: "Resource", slug: name },
              content: body,
            },
          ],
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      await soulLoader.reload();
      // Materialise the new type's Postgres table before the client can POST records to it.
      await reconcile?.();
      await auditWrite(req, "resource-type.create", `resource-type:${name}`);

      return reply.code(201).send({
        name,
        schema: schemaYaml,
        hasHooks: false,
        ...(domain === undefined ? {} : { domain }),
      });
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
          200: ListResourceTypesResponseSchema,
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const types = Array.from(soulLoader.resources.values()).map(resourceTypePayload);
      return reply.send({ types });
    }
  );

  app.put(
    "/api/v1/resource-types/:name",
    {
      preHandler: writeHandlers,
      schema: {
        description:
          "Replace an existing resource type's schema. `schema` is a YAML string (JSON Schema).",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ResourceTypeNameParamsSchema,
        body: UpdateResourceTypeBodySchema,
        response: {
          200: ResourceTypeResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ResourceTypeValidationErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const { schema: schemaYaml, domain } = req.body as { schema: string; domain?: string };

      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      if (domain !== undefined && !RESOURCE_DOMAIN_RE.test(domain)) {
        return reply.code(400).send({ error: "invalid resource type domain" });
      }
      const typeDir = join(soulPath, "resources", name);
      if (!existsSync(typeDir)) {
        return reply.code(404).send({ error: "resource type not found" });
      }
      const existingDomain = soulLoader.resources.get(name)?.domain;
      // Only a *change* of domain needs admin — a member editing the schema of a domained Resource
      // omits `domain` and keeps the existing wall, which is the ordinary case.
      if (
        domain !== undefined &&
        domain !== existingDomain &&
        !(await mayChangeDomain(req, SET_DOMAIN))
      ) {
        return reply.code(403).send({ error: "only an admin can change a resource type's domain" });
      }
      const check = checkSchemaYaml(schemaYaml);
      if (!check.ok) return reply.code(check.status).send(check.body);

      const nextDomain = domain ?? existingDomain;
      let changes: SoulWrite[];
      if (nextDomain === undefined) {
        changes = [
          {
            op: "put",
            target: { kind: "Resource", slug: name, definitionMode: "legacy" },
            content: schemaYaml,
          },
        ];
      } else {
        const body = resourceDefinitionYaml({
          name,
          schema: check.parsed,
          domain: nextDomain,
        });
        const envelopeError = resourceEnvelopeError(body);
        if (envelopeError !== undefined) {
          return reply.code(422).send({ error: envelopeError });
        }
        // The canonical put and the legacy retirement must ride the same changeset: the gateway
        // refuses a tree that carries both spellings of one definition.
        changes = [
          { op: "put", target: { kind: "Resource", slug: name }, content: body },
          { op: "delete", target: { kind: "Resource", slug: name, definitionMode: "legacy" } },
        ];
      }

      try {
        await soulWriter.apply({
          subject: `soul: update resource type ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes,
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      await soulLoader.reload();
      // New columns may have been added — materialise them before records reference them.
      await reconcile?.();
      await auditWrite(req, "resource-type.update", `resource-type:${name}`);

      const reloaded = soulLoader.resources.get(name);
      return reply.code(200).send({
        name,
        schema: schemaYaml,
        hasHooks: reloaded?.hasHooks ?? false,
        ...(reloaded?.domain === undefined ? {} : { domain: reloaded.domain }),
      });
    }
  );

  app.delete(
    "/api/v1/resource-types/:name",
    {
      preHandler: writeHandlers,
      schema: {
        description:
          "Remove a resource type definition from the soul. The Postgres table is left intact " +
          "(non-destructive) so existing records remain recoverable.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ResourceTypeNameParamsSchema,
        response: {
          204: ResourceTypeDeleteResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      const typeDir = join(soulPath, "resources", name);
      if (!existsSync(typeDir)) {
        return reply.code(404).send({ error: "resource type not found" });
      }
      // Without this a member could delete a domained Resource and re-create it domainless,
      // walking around the admin gate on POST and taking the wall down by the back door.
      if (
        soulLoader.resources.get(name)?.domain !== undefined &&
        !(await mayChangeDomain(req, DELETE_DOMAINED))
      ) {
        return reply.code(403).send({ error: "only an admin can delete a domained resource type" });
      }
      try {
        await soulWriter.apply({
          subject: `soul: remove resource type ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          // Takes the definition *and* every companion beside it (`hooks.ts`), matching the
          // recursive directory removal this replaced.
          changes: [{ op: "deleteArtifact", kind: "Resource", slug: name }],
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      await soulLoader.reload();
      await auditWrite(req, "resource-type.delete", `resource-type:${name}`);
      return reply.code(204).send();
    }
  );

  app.get(
    "/api/v1/resource-types/:name/hooks",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get the hooks.ts source for a resource type, or null if none exists.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ResourceTypeNameParamsSchema,
        response: { 200: ResourceTypeHooksResponseSchema, 401: ErrorSchema, 404: ErrorSchema },
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
      preHandler: writeHandlers,
      schema: {
        description:
          "Create or replace the hooks.ts file for a resource type. " +
          "Runs static analysis to block banned patterns.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ResourceTypeNameParamsSchema,
        body: UpdateResourceTypeHooksBodySchema,
        response: {
          200: ResourceTypeHooksResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ResourceTypeValidationErrorSchema,
          500: ErrorSchema,
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

      try {
        await soulWriter.apply({
          subject: `soul: add hooks for resource type ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [
            {
              op: "put",
              target: { kind: "Resource", slug: name, companion: "hooks.ts" },
              content: source,
            },
          ],
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      await soulLoader.reload();
      // Hooks are executable code running against business data — the highest-value write here.
      await auditWrite(req, "resource-type.hooks.write", `resource-type:${name}`);

      return reply.send({ name, hasHooks: true, source });
    }
  );

  app.delete(
    "/api/v1/resource-types/:name/hooks",
    {
      preHandler: writeHandlers,
      schema: {
        description: "Remove the hooks.ts file for a resource type.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ResourceTypeNameParamsSchema,
        response: {
          204: ResourceTypeHooksDeleteResponseSchema,
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
      const { name } = req.params as { name: string };
      if (!name || !NAME_RE.test(name)) {
        return reply.code(400).send({ error: "invalid resource type name" });
      }
      if (!soulLoader.resources.has(name)) {
        return reply.code(404).send({ error: `resource type not found: ${name}` });
      }

      if (soulWriter.readCompanion("Resource", name, "hooks.ts") === null) {
        return reply.code(404).send({ error: `no hooks found for resource type: ${name}` });
      }

      try {
        await soulWriter.apply({
          subject: `soul: remove hooks for resource type ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [
            { op: "delete", target: { kind: "Resource", slug: name, companion: "hooks.ts" } },
          ],
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      await soulLoader.reload();
      await auditWrite(req, "resource-type.hooks.delete", `resource-type:${name}`);
      return reply.code(204).send();
    }
  );
}
