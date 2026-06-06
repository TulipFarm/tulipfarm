import { randomUUID } from "node:crypto";
import type { SoulLoader } from "@tulipfarm/soul";
import { TulipFarmValidationError, ajv, applyTransforms } from "@tulipfarm/validation";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { ErrorSchema } from "../auth/schemas";
import { HookError, type HookExecutor } from "../hooks/hook-executor.js";
import { parsePaginationQuery } from "../pagination";
import { MongoCounterStore, MongoResourceRepo, makeHistoryEntry, toApiRecord } from "./repo";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const RecordSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    version: { type: "number" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "version", "createdAt", "updatedAt"],
} as const;

const ValidationErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    boundary: { type: "string" },
    path: { type: "string" },
  },
  required: ["error"],
} as const;

function parseIfMatch(req: FastifyRequest): number | null {
  const raw = req.headers["if-match"];
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw.replace(/^"(.*)"$/, "$1"), 10);
  return Number.isNaN(n) ? null : n;
}

function stripSystemFields(data: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, version: _v, createdAt: _ca, updatedAt: _ua, deletedAt: _da, ...rest } = data;
  return rest;
}

function stripReadOnly(
  schema: Record<string, unknown>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out = { ...data };
  for (const [field, propSchema] of Object.entries(props)) {
    if (propSchema["x-readOnly"] === true) delete out[field];
  }
  return out;
}

function stripImmutable(
  schema: Record<string, unknown>,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out = { ...incoming };
  for (const [field, propSchema] of Object.entries(props)) {
    if (propSchema["x-immutable"] === true && existing[field] !== undefined) {
      out[field] = existing[field];
    }
  }
  return out;
}

function extractLinks(schema: Record<string, unknown>): Array<{ field: string; target: string }> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const links: Array<{ field: string; target: string }> = [];
  for (const [field, propSchema] of Object.entries(props)) {
    const xl = propSchema["x-links"];
    if (
      xl &&
      typeof xl === "object" &&
      !Array.isArray(xl) &&
      typeof (xl as { target?: unknown }).target === "string"
    ) {
      links.push({ field, target: (xl as { target: string }).target });
    }
  }
  return links;
}

async function validateLinks(
  links: Array<{ field: string; target: string }>,
  data: Record<string, unknown>,
  db: Db,
  soulLoader: SoulLoader
): Promise<{ field: string; id: string } | null> {
  for (const { field, target } of links) {
    const id = data[field];
    if (id == null || typeof id !== "string") continue;
    if (!soulLoader.resources.has(target)) continue;
    const targetRepo = new MongoResourceRepo(db, target);
    const doc = await targetRepo.findById(id);
    if (!doc || doc.deletedAt != null) return { field, id };
  }
  return null;
}

export function registerResourceRoutes(
  app: FastifyInstance,
  db: Db,
  soulLoader: SoulLoader,
  requireAuth: PreHandler,
  hookExecutor?: HookExecutor
): void {
  const counterStore = new MongoCounterStore(db);
  const counter = counterStore.makeCounterFn();

  // ── POST /api/v1/resources/:type ────────────────────────────────────────────
  app.post(
    "/api/v1/resources/:type",
    {
      preHandler: requireAuth,
      schema: {
        description: "Create a new resource record.",
        tags: ["resources"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
        body: { type: "object", additionalProperties: true },
        response: {
          201: RecordSchema,
          404: ErrorSchema,
          422: ValidationErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { type } = req.params as { type: string };
      const resourceDef = soulLoader.resources.get(type);
      if (!resourceDef) return reply.code(404).send({ error: `resource type not found: ${type}` });

      const schema = resourceDef.schema;
      const now = new Date();
      const id = randomUUID();

      let data = stripSystemFields(req.body as Record<string, unknown>);
      data = stripReadOnly(schema, data);

      try {
        data = await applyTransforms(type, schema, data, { counter });
      } catch (err) {
        if (err instanceof TulipFarmValidationError) {
          return reply
            .code(422)
            .send({ error: err.message, boundary: err.boundary, path: err.path });
        }
        throw err;
      }

      const validate = ajv.compile(schema);
      if (!validate(data)) {
        const e = validate.errors?.[0];
        return reply
          .code(422)
          .send({ error: e?.message ?? "validation failed", path: e?.instancePath ?? "" });
      }

      const linkErr = await validateLinks(extractLinks(schema), data, db, soulLoader);
      if (linkErr) {
        return reply
          .code(422)
          .send({ error: `linked record not found: ${linkErr.id}`, path: `/${linkErr.field}` });
      }

      if (hookExecutor && resourceDef.hookSource && resourceDef.hooksEnabled !== false) {
        try {
          data = await hookExecutor.runBeforeHook(
            resourceDef.hookSource,
            type,
            data,
            resourceDef.hookHash
          );
        } catch (err) {
          if (err instanceof HookError) {
            return reply.code(422).send({ error: err.message });
          }
          throw err;
        }
      }

      const doc = { _id: id, version: 1, createdAt: now, updatedAt: now, ...data };
      const repo = new MongoResourceRepo(db, type);
      await repo.insert(doc);
      await repo.appendHistory(makeHistoryEntry(id, "create", doc));

      if (hookExecutor && resourceDef.hookSource && resourceDef.hooksEnabled !== false) {
        await hookExecutor.runAfterHook(
          resourceDef.hookSource,
          type,
          toApiRecord(doc),
          resourceDef.hookHash
        );
      }

      return reply.code(201).send(toApiRecord(doc));
    }
  );

  // ── GET /api/v1/resources/:type ─────────────────────────────────────────────
  app.get(
    "/api/v1/resources/:type",
    {
      preHandler: requireAuth,
      schema: {
        description: "List resource records (cursor paginated). Soft-deleted excluded by default.",
        tags: ["resources"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "number" },
            includeDeleted: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              items: { type: "array", items: RecordSchema },
              nextCursor: { type: "string", nullable: true },
            },
            required: ["items", "nextCursor"],
          },
          404: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { type } = req.params as { type: string };
      if (!soulLoader.resources.has(type)) {
        return reply.code(404).send({ error: `resource type not found: ${type}` });
      }

      const query = req.query as Record<string, unknown>;
      const { limit, after } = parsePaginationQuery(query);
      const includeDeleted = query.includeDeleted === true || query.includeDeleted === "true";

      const repo = new MongoResourceRepo(db, type);
      const result = await repo.list({ limit, after, includeDeleted });

      return reply.send({
        items: result.items.map(toApiRecord),
        nextCursor: result.nextCursor,
      });
    }
  );

  // ── GET /api/v1/resources/:type/:id ─────────────────────────────────────────
  app.get(
    "/api/v1/resources/:type/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get a single resource record.",
        tags: ["resources"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          properties: { type: { type: "string" }, id: { type: "string" } },
          required: ["type", "id"],
        },
        response: { 200: RecordSchema, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { type, id } = req.params as { type: string; id: string };
      if (!soulLoader.resources.has(type)) {
        return reply.code(404).send({ error: `resource type not found: ${type}` });
      }

      const repo = new MongoResourceRepo(db, type);
      const doc = await repo.findById(id);
      if (!doc || doc.deletedAt != null) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.send(toApiRecord(doc));
    }
  );

  // ── PUT /api/v1/resources/:type/:id ─────────────────────────────────────────
  app.put(
    "/api/v1/resources/:type/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Full replace. Requires If-Match header with current version.",
        tags: ["resources"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          properties: { type: { type: "string" }, id: { type: "string" } },
          required: ["type", "id"],
        },
        body: { type: "object", additionalProperties: true },
        response: {
          200: RecordSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ValidationErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { type, id } = req.params as { type: string; id: string };
      const resourceDef = soulLoader.resources.get(type);
      if (!resourceDef) return reply.code(404).send({ error: `resource type not found: ${type}` });

      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });

      const repo = new MongoResourceRepo(db, type);
      const existing = await repo.findById(id);
      if (!existing || existing.deletedAt != null)
        return reply.code(404).send({ error: "not found" });
      if (existing.version !== ifMatch) return reply.code(409).send({ error: "version conflict" });

      const schema = resourceDef.schema;
      let data = stripSystemFields(req.body as Record<string, unknown>);
      data = stripReadOnly(schema, data);
      data = stripImmutable(schema, existing, data);

      try {
        data = await applyTransforms(type, schema, data, { counter });
      } catch (err) {
        if (err instanceof TulipFarmValidationError) {
          return reply
            .code(422)
            .send({ error: err.message, boundary: err.boundary, path: err.path });
        }
        throw err;
      }

      const validate = ajv.compile(schema);
      if (!validate(data)) {
        const e = validate.errors?.[0];
        return reply
          .code(422)
          .send({ error: e?.message ?? "validation failed", path: e?.instancePath ?? "" });
      }

      const linkErr = await validateLinks(extractLinks(schema), data, db, soulLoader);
      if (linkErr) {
        return reply
          .code(422)
          .send({ error: `linked record not found: ${linkErr.id}`, path: `/${linkErr.field}` });
      }

      if (hookExecutor && resourceDef.hookSource && resourceDef.hooksEnabled !== false) {
        try {
          data = await hookExecutor.runBeforeHook(
            resourceDef.hookSource,
            type,
            data,
            resourceDef.hookHash
          );
        } catch (err) {
          if (err instanceof HookError) {
            return reply.code(422).send({ error: err.message });
          }
          throw err;
        }
      }

      const now = new Date();
      const newDoc = {
        _id: id,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
        ...data,
      };

      const replaced = await repo.replaceOne(id, existing.version, newDoc);
      if (!replaced) return reply.code(409).send({ error: "version conflict" });

      await repo.appendHistory(makeHistoryEntry(id, "update", newDoc));

      if (hookExecutor && resourceDef.hookSource && resourceDef.hooksEnabled !== false) {
        await hookExecutor.runAfterHook(
          resourceDef.hookSource,
          type,
          toApiRecord(newDoc),
          resourceDef.hookHash
        );
      }

      return reply.send(toApiRecord(newDoc));
    }
  );

  // ── PATCH /api/v1/resources/:type/:id ───────────────────────────────────────
  app.patch(
    "/api/v1/resources/:type/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Partial update. Requires If-Match header with current version.",
        tags: ["resources"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          properties: { type: { type: "string" }, id: { type: "string" } },
          required: ["type", "id"],
        },
        body: { type: "object", additionalProperties: true },
        response: {
          200: RecordSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ValidationErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { type, id } = req.params as { type: string; id: string };
      const resourceDef = soulLoader.resources.get(type);
      if (!resourceDef) return reply.code(404).send({ error: `resource type not found: ${type}` });

      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });

      const repo = new MongoResourceRepo(db, type);
      const existing = await repo.findById(id);
      if (!existing || existing.deletedAt != null)
        return reply.code(404).send({ error: "not found" });
      if (existing.version !== ifMatch) return reply.code(409).send({ error: "version conflict" });

      const schema = resourceDef.schema;
      const {
        _id: _eid,
        version: _ev,
        createdAt: _eca,
        updatedAt: _eua,
        deletedAt: _eda,
        ...existingData
      } = existing;

      let patch = stripSystemFields(req.body as Record<string, unknown>);
      patch = stripReadOnly(schema, patch);
      const merged = stripImmutable(schema, existingData, { ...existingData, ...patch });

      let data = merged;
      try {
        data = await applyTransforms(type, schema, data, { counter });
      } catch (err) {
        if (err instanceof TulipFarmValidationError) {
          return reply
            .code(422)
            .send({ error: err.message, boundary: err.boundary, path: err.path });
        }
        throw err;
      }

      const validate = ajv.compile(schema);
      if (!validate(data)) {
        const e = validate.errors?.[0];
        return reply
          .code(422)
          .send({ error: e?.message ?? "validation failed", path: e?.instancePath ?? "" });
      }

      const linkErr = await validateLinks(extractLinks(schema), data, db, soulLoader);
      if (linkErr) {
        return reply
          .code(422)
          .send({ error: `linked record not found: ${linkErr.id}`, path: `/${linkErr.field}` });
      }

      if (hookExecutor && resourceDef.hookSource && resourceDef.hooksEnabled !== false) {
        try {
          data = await hookExecutor.runBeforeHook(
            resourceDef.hookSource,
            type,
            data,
            resourceDef.hookHash
          );
        } catch (err) {
          if (err instanceof HookError) {
            return reply.code(422).send({ error: err.message });
          }
          throw err;
        }
      }

      const now = new Date();
      const newDoc = {
        _id: id,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
        ...data,
      };

      const replaced = await repo.replaceOne(id, existing.version, newDoc);
      if (!replaced) return reply.code(409).send({ error: "version conflict" });

      await repo.appendHistory(makeHistoryEntry(id, "update", newDoc));

      if (hookExecutor && resourceDef.hookSource && resourceDef.hooksEnabled !== false) {
        await hookExecutor.runAfterHook(
          resourceDef.hookSource,
          type,
          toApiRecord(newDoc),
          resourceDef.hookHash
        );
      }

      return reply.send(toApiRecord(newDoc));
    }
  );

  // ── DELETE /api/v1/resources/:type/:id ──────────────────────────────────────
  app.delete(
    "/api/v1/resources/:type/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Soft delete. Requires If-Match header with current version.",
        tags: ["resources"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          properties: { type: { type: "string" }, id: { type: "string" } },
          required: ["type", "id"],
        },
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { type, id } = req.params as { type: string; id: string };
      if (!soulLoader.resources.has(type)) {
        return reply.code(404).send({ error: `resource type not found: ${type}` });
      }

      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });

      const repo = new MongoResourceRepo(db, type);
      const existing = await repo.findById(id);
      if (!existing || existing.deletedAt != null)
        return reply.code(404).send({ error: "not found" });
      if (existing.version !== ifMatch) return reply.code(409).send({ error: "version conflict" });

      const now = new Date();
      const softDeleted = {
        ...existing,
        version: existing.version + 1,
        updatedAt: now,
        deletedAt: now,
      };

      const replaced = await repo.replaceOne(id, existing.version, softDeleted);
      if (!replaced) return reply.code(409).send({ error: "version conflict" });

      await repo.appendHistory(makeHistoryEntry(id, "delete", softDeleted));
      return reply.code(204).send();
    }
  );
}
