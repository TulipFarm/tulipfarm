import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { HookExecutor } from "@tulipfarm/sandbox";
import type { SoulLoader } from "@tulipfarm/soul";
import { parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RecordAction, RecordAuthorizer } from "./authorize";
import { recordPrincipalOf } from "./authorize";
import {
  deliverResourceSideEffect,
  type ResourceMutationKind,
  type ResourceSideEffect,
} from "./outbox";
import {
  type CounterStore,
  type ResourceDoc,
  type ResourceRepo,
  type ResourceRepoFactory,
  toApiRecord,
} from "./repo";
import {
  loadForWrite,
  maybeRunBeforeHook,
  stripImmutable,
  stripReadOnly,
  stripSystemFields,
  transformAndValidate,
  validateAndLink,
} from "./write-pipeline.js";

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

function idempotencyKey(req: FastifyRequest): string | null | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  return key.length > 0 && key.length <= 200 ? key : null;
}

type HookedResource = {
  readonly hookSource?: string;
  readonly hookHash?: string;
  readonly hooksEnabled?: boolean;
};

function resourceSideEffect(
  kind: ResourceMutationKind,
  resourceDef: HookedResource,
  type: string,
  doc: ResourceDoc,
  actorId?: string
): ResourceSideEffect {
  const afterHook =
    resourceDef.hookSource && resourceDef.hooksEnabled !== false
      ? { source: resourceDef.hookSource, hash: resourceDef.hookHash }
      : undefined;
  return {
    kind,
    resourceType: type,
    resourceId: doc._id,
    record: toApiRecord(doc),
    ...(actorId === undefined ? {} : { actorId }),
    ...(afterHook === undefined ? {} : { afterHook }),
  };
}

async function deliverImmediatelyWhenUndurable(
  repo: ResourceRepo,
  effect: ResourceSideEffect,
  hookExecutor: HookExecutor | undefined,
  events: EventEmitter | undefined
): Promise<void> {
  if (repo.durableSideEffects) return;
  await deliverResourceSideEffect(effect, hookExecutor, events);
}

export function registerResourceRoutes(
  app: FastifyInstance,
  repoFactory: ResourceRepoFactory,
  counterStore: CounterStore,
  soulLoader: SoulLoader,
  requireAuth: PreHandler,
  hookExecutor?: HookExecutor,
  events?: EventEmitter,
  /** Optional only for tests/pre-auth boot; production wires record authority. */
  recordAuthorizer?: RecordAuthorizer
): void {
  const counter = counterStore.makeCounterFn();

  /** Refuse uncovered or undescribable principals with the shared `403` denial shape. */
  async function denyUnauthorized(
    req: FastifyRequest,
    reply: FastifyReply,
    action: RecordAction,
    type: string,
    id?: string
  ): Promise<boolean> {
    if (recordAuthorizer === undefined) return false;
    const principal = recordPrincipalOf(req);
    if (principal === undefined) {
      await reply.code(403).send({ error: "not authorized for this resource" });
      return true;
    }
    const allowed = await recordAuthorizer.authorize({
      principal,
      action,
      type,
      ...(id === undefined ? {} : { id }),
    });
    if (allowed) return false;
    await reply.code(403).send({ error: "not authorized for this resource" });
    return true;
  }

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
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: { type: "object", additionalProperties: true },
        response: {
          200: RecordSchema,
          201: RecordSchema,
          400: ErrorSchema,
          403: ErrorSchema,
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
      if (await denyUnauthorized(req, reply, "record.create", type)) return reply;

      const schema = resourceDef.schema;
      const now = new Date();
      const id = randomUUID();

      let data = stripReadOnly(schema, stripSystemFields(req.body as Record<string, unknown>));

      const prepared = await transformAndValidate(
        type,
        schema,
        data,
        counter,
        repoFactory,
        soulLoader
      );
      if (!prepared.ok) return reply.code(prepared.err.code).send(prepared.err.body);
      data = prepared.data;

      const before = await maybeRunBeforeHook(hookExecutor, resourceDef, type, data);
      if (!before.ok) return reply.code(before.err.code).send(before.err.body);
      data = before.data;
      if (before.ran) {
        const reErr = await validateAndLink(schema, data, repoFactory, soulLoader);
        if (reErr) return reply.code(reErr.code).send(reErr.body);
      }

      const doc = { _id: id, version: 1, createdAt: now, updatedAt: now, ...data };
      const repo = repoFactory.forType(type);
      const actorId = (req.user as { _id: string } | undefined)?._id;
      const effect = resourceSideEffect("create", resourceDef, type, doc, actorId);
      const key = idempotencyKey(req);
      if (key === null) return reply.code(400).send({ error: "invalid Idempotency-Key header" });

      if (key !== undefined && repo.createIdempotently) {
        const result = await repo.createIdempotently(doc, key, effect);
        if (result.created) {
          await deliverImmediatelyWhenUndurable(repo, effect, hookExecutor, events);
        }
        return reply.code(result.created ? 201 : 200).send(toApiRecord(result.doc));
      }

      await repo.insert(doc, effect);
      await deliverImmediatelyWhenUndurable(repo, effect, hookExecutor, events);
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
          403: ErrorSchema,
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
      if (await denyUnauthorized(req, reply, "record.list", type)) return reply;

      const query = req.query as Record<string, unknown>;
      const { limit, after } = parsePaginationQuery(query);
      const includeDeleted = query.includeDeleted === true || query.includeDeleted === "true";

      const repo = repoFactory.forType(type);
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
        response: { 200: RecordSchema, 403: ErrorSchema, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { type, id } = req.params as { type: string; id: string };
      if (!soulLoader.resources.has(type)) {
        return reply.code(404).send({ error: `resource type not found: ${type}` });
      }
      if (await denyUnauthorized(req, reply, "record.read", type, id)) return reply;

      const repo = repoFactory.forType(type);
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
          403: ErrorSchema,
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
      if (await denyUnauthorized(req, reply, "record.update", type, id)) return reply;

      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });

      const repo = repoFactory.forType(type);
      const loaded = await loadForWrite(repo, id, ifMatch);
      if (!loaded.ok) return reply.code(loaded.err.code).send(loaded.err.body);
      const existing = loaded.doc;

      const schema = resourceDef.schema;
      let data = stripImmutable(
        schema,
        existing,
        stripReadOnly(schema, stripSystemFields(req.body as Record<string, unknown>))
      );

      const prepared = await transformAndValidate(
        type,
        schema,
        data,
        counter,
        repoFactory,
        soulLoader
      );
      if (!prepared.ok) return reply.code(prepared.err.code).send(prepared.err.body);
      data = prepared.data;

      const before = await maybeRunBeforeHook(hookExecutor, resourceDef, type, data);
      if (!before.ok) return reply.code(before.err.code).send(before.err.body);
      data = before.data;
      if (before.ran) {
        const reErr = await validateAndLink(schema, data, repoFactory, soulLoader);
        if (reErr) return reply.code(reErr.code).send(reErr.body);
      }

      const now = new Date();
      const newDoc = {
        _id: id,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
        ...data,
      };

      const effect = resourceSideEffect(
        "update",
        resourceDef,
        type,
        newDoc,
        (req.user as { _id: string } | undefined)?._id
      );
      const replaced = await repo.replaceOne(id, existing.version, newDoc, "update", effect);
      if (!replaced) return reply.code(409).send({ error: "version conflict" });
      await deliverImmediatelyWhenUndurable(repo, effect, hookExecutor, events);

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
          403: ErrorSchema,
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
      if (await denyUnauthorized(req, reply, "record.update", type, id)) return reply;

      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });

      const repo = repoFactory.forType(type);
      const loaded = await loadForWrite(repo, id, ifMatch);
      if (!loaded.ok) return reply.code(loaded.err.code).send(loaded.err.body);
      const existing = loaded.doc;

      const schema = resourceDef.schema;
      const {
        _id: _eid,
        version: _ev,
        createdAt: _eca,
        updatedAt: _eua,
        deletedAt: _eda,
        ...existingData
      } = existing;

      const patch = stripReadOnly(schema, stripSystemFields(req.body as Record<string, unknown>));
      let data = stripImmutable(schema, existingData, { ...existingData, ...patch });

      const prepared = await transformAndValidate(
        type,
        schema,
        data,
        counter,
        repoFactory,
        soulLoader
      );
      if (!prepared.ok) return reply.code(prepared.err.code).send(prepared.err.body);
      data = prepared.data;

      const before = await maybeRunBeforeHook(hookExecutor, resourceDef, type, data);
      if (!before.ok) return reply.code(before.err.code).send(before.err.body);
      data = before.data;
      if (before.ran) {
        const reErr = await validateAndLink(schema, data, repoFactory, soulLoader);
        if (reErr) return reply.code(reErr.code).send(reErr.body);
      }

      const now = new Date();
      const newDoc = {
        _id: id,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
        ...data,
      };

      const effect = resourceSideEffect(
        "update",
        resourceDef,
        type,
        newDoc,
        (req.user as { _id: string } | undefined)?._id
      );
      const replaced = await repo.replaceOne(id, existing.version, newDoc, "update", effect);
      if (!replaced) return reply.code(409).send({ error: "version conflict" });
      await deliverImmediatelyWhenUndurable(repo, effect, hookExecutor, events);

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
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          401: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { type, id } = req.params as { type: string; id: string };
      const resourceDef = soulLoader.resources.get(type);
      if (!resourceDef) {
        return reply.code(404).send({ error: `resource type not found: ${type}` });
      }
      if (await denyUnauthorized(req, reply, "record.delete", type, id)) return reply;

      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });

      const repo = repoFactory.forType(type);
      const loaded = await loadForWrite(repo, id, ifMatch);
      if (!loaded.ok) return reply.code(loaded.err.code).send(loaded.err.body);
      const existing = loaded.doc;

      const before = await maybeRunBeforeHook(
        hookExecutor,
        resourceDef,
        type,
        toApiRecord(existing)
      );
      if (!before.ok) return reply.code(before.err.code).send(before.err.body);

      const now = new Date();
      const softDeleted = {
        ...existing,
        version: existing.version + 1,
        updatedAt: now,
        deletedAt: now,
      };

      const effect = resourceSideEffect(
        "delete",
        resourceDef,
        type,
        softDeleted,
        (req.user as { _id: string } | undefined)?._id
      );
      const replaced = await repo.replaceOne(id, existing.version, softDeleted, "delete", effect);
      if (!replaced) return reply.code(409).send({ error: "version conflict" });
      await deliverImmediatelyWhenUndurable(repo, effect, hookExecutor, events);
      return reply.code(204).send();
    }
  );
}
