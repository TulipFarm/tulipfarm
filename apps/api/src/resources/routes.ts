import type { EventEmitter } from "node:events";
import {
  createRecord,
  deleteRecord,
  ResourceBeforeHookError,
  type ResourceWritePorts,
  updateRecord,
} from "@tulipfarm/resources";
import { HookError, type HookExecutor } from "@tulipfarm/sandbox";
import type { SoulLoader } from "@tulipfarm/soul";
import { parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RecordAction, RecordAuthorizer } from "./authorize";
import { recordPrincipalOf } from "./authorize";
import { deliverResourceSideEffect, type ResourceSideEffect } from "./outbox";
import { type CounterStore, type ResourceRepoFactory, toApiRecord } from "./repo";

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

const CatalogEntrySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "number" },
    lastUpdatedAt: { type: "string", nullable: true },
  },
  required: ["name", "count", "lastUpdatedAt"],
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

async function deliverImmediatelyWhenUndurable(
  repo: { readonly durableSideEffects?: true },
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
  const writePorts: ResourceWritePorts = {
    catalog: soulLoader.resources,
    repositories: repoFactory,
    counter,
    ...(hookExecutor
      ? {
          beforeHook: {
            run: async (source, type, data, hash) => {
              try {
                return await hookExecutor.runBeforeHook(source, type, data, hash);
              } catch (error) {
                if (error instanceof HookError) throw new ResourceBeforeHookError(error.message);
                throw error;
              }
            },
          },
        }
      : {}),
  };

  /** Refuse uncovered or undescribable principals with the shared `403` denial shape. */
  async function denyUnauthorized(
    req: FastifyRequest,
    reply: FastifyReply,
    action: RecordAction,
    type: string,
    id?: string
  ): Promise<boolean> {
    if (await isAuthorized(req, action, type, id)) return false;
    await reply.code(403).send({ error: "not authorized for this resource" });
    return true;
  }

  /** The same decision without a reply, for the catalog loop that skips rather than refuses. */
  async function isAuthorized(
    req: FastifyRequest,
    action: RecordAction,
    type: string,
    id?: string
  ): Promise<boolean> {
    if (recordAuthorizer === undefined) return true;
    const principal = recordPrincipalOf(req);
    if (principal === undefined) return false;
    return recordAuthorizer.authorize({
      principal,
      action,
      type,
      ...(id === undefined ? {} : { id }),
    });
  }

  // ── GET /api/v1/resources ───────────────────────────────────────────────────
  app.get(
    "/api/v1/resources",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Catalog totals per resource type. A type the caller may not list is omitted, so a count never discloses data behind a denied type.",
        tags: ["resources"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { types: { type: "array", items: CatalogEntrySchema } },
            required: ["types"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const names = Array.from(soulLoader.resources.keys());
      const entries = await Promise.all(
        names.map(async (name) => {
          if (!(await isAuthorized(req, "record.list", name))) return null;
          const repo = repoFactory.forType(name);
          if (typeof repo.stats !== "function") return null;
          try {
            const { count, lastUpdatedAt } = await repo.stats();
            return {
              name,
              count,
              lastUpdatedAt: lastUpdatedAt === null ? null : lastUpdatedAt.toISOString(),
            };
          } catch (error) {
            // One unreadable table must not blank the whole catalog; that type reports no totals.
            req.log.warn({ err: error, type: name }, "resource catalog stats failed");
            return null;
          }
        })
      );
      return reply.send({ types: entries.filter((entry) => entry !== null) });
    }
  );

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
          409: ErrorSchema,
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

      const actorId = (req.user as { _id: string } | undefined)?._id;
      const key = idempotencyKey(req);
      if (key === null) return reply.code(400).send({ error: "invalid Idempotency-Key header" });
      const created = await createRecord(
        {
          type,
          resource: resourceDef,
          data: req.body as Record<string, unknown>,
          actorId,
          ...(key === undefined ? {} : { idempotencyKey: key }),
        },
        writePorts
      );
      if (!created.ok) return reply.code(created.err.code).send(created.err.body);
      if (!created.replayed) {
        await deliverImmediatelyWhenUndurable(
          created.repo,
          created.sideEffect,
          hookExecutor,
          events
        );
      }
      return reply.code(created.replayed ? 200 : 201).send(toApiRecord(created.doc));
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

      const updated = await updateRecord(
        {
          type,
          resource: resourceDef,
          id,
          expectedVersion: ifMatch,
          data: req.body as Record<string, unknown>,
          mode: "replace",
          actorId: (req.user as { _id: string } | undefined)?._id,
        },
        writePorts
      );
      if (!updated.ok) return reply.code(updated.err.code).send(updated.err.body);
      await deliverImmediatelyWhenUndurable(updated.repo, updated.sideEffect, hookExecutor, events);
      return reply.send(toApiRecord(updated.doc));
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

      const updated = await updateRecord(
        {
          type,
          resource: resourceDef,
          id,
          expectedVersion: ifMatch,
          data: req.body as Record<string, unknown>,
          mode: "patch",
          actorId: (req.user as { _id: string } | undefined)?._id,
        },
        writePorts
      );
      if (!updated.ok) return reply.code(updated.err.code).send(updated.err.body);
      await deliverImmediatelyWhenUndurable(updated.repo, updated.sideEffect, hookExecutor, events);
      return reply.send(toApiRecord(updated.doc));
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

      const deleted = await deleteRecord(
        {
          type,
          resource: resourceDef,
          id,
          expectedVersion: ifMatch,
          actorId: (req.user as { _id: string } | undefined)?._id,
        },
        writePorts
      );
      if (!deleted.ok) return reply.code(deleted.err.code).send(deleted.err.body);
      await deliverImmediatelyWhenUndurable(deleted.repo, deleted.sideEffect, hookExecutor, events);
      return reply.code(204).send();
    }
  );
}
