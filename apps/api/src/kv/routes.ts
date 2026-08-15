import type { KvEntry, KvScope, KvService } from "@tulipfarm/kv";
import { MAX_VALUE_BYTES } from "@tulipfarm/kv";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface ScopeConfig {
  scope: KvScope;
  prefix: string;
  /** Owner derived from the authenticated caller — never from the request body/path. */
  resolveOwner: (req: FastifyRequest) => string | undefined;
  requireAdmin: boolean;
  tag: string;
}

const PARAMS_NS_KEY = {
  type: "object",
  required: ["namespace", "key"],
  properties: { namespace: { type: "string" }, key: { type: "string" } },
} as const;

const PARAMS_NS = {
  type: "object",
  required: ["namespace"],
  properties: { namespace: { type: "string" } },
} as const;

// `value` carries no type constraint (any JSON); ttlSeconds is an optional positive TTL.
const PUT_BODY = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: { value: {}, ttlSeconds: { type: "integer", minimum: 1 } },
} as const;

/** API view of an entry; value passes through untouched so jsonb is not mangled. */
function toApi(entry: KvEntry): Record<string, unknown> {
  return {
    namespace: entry.namespace,
    key: entry.key,
    value: entry.value,
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt.toISOString() } : {}),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/** Registers scope-pinned CRUD routes; scope and owner never come from the request. */
function registerScopedKvRoutes(
  app: FastifyInstance,
  kvService: KvService,
  requireAuth: PreHandler,
  cfg: ScopeConfig
): void {
  const { scope, prefix, resolveOwner, requireAdmin, tag } = cfg;
  const security: { [k: string]: readonly string[] }[] = [
    { sessionCookie: [] },
    { bearerToken: [] },
  ];

  /** Returns true if the caller may proceed; otherwise sends 403 and returns false. */
  const allowed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (requireAdmin && (req.user as UserDoc).role !== "admin") {
      reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  };

  app.get(
    `${prefix}/:namespace/:key`,
    {
      preHandler: requireAuth,
      schema: { description: "Read a KV entry.", tags: [tag], security, params: PARAMS_NS_KEY },
    },
    async (req, reply) => {
      if (!allowed(req, reply)) return;
      const { namespace, key } = req.params as { namespace: string; key: string };
      const entry = await kvService.get(scope, resolveOwner(req), namespace, key);
      if (!entry) return reply.code(404).send({ error: "not found" });
      return reply.send(toApi(entry));
    }
  );

  app.put(
    `${prefix}/:namespace/:key`,
    {
      preHandler: requireAuth,
      schema: {
        description: "Create or update a KV entry (last-write-wins).",
        tags: [tag],
        security,
        params: PARAMS_NS_KEY,
        body: PUT_BODY,
        response: { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (!allowed(req, reply)) return;
      const { namespace, key } = req.params as { namespace: string; key: string };
      const body = (req.body ?? {}) as { value?: unknown; ttlSeconds?: number };
      if (body.value === undefined) return reply.code(400).send({ error: "value is required" });
      const expiresAt =
        typeof body.ttlSeconds === "number"
          ? new Date(Date.now() + body.ttlSeconds * 1000)
          : undefined;
      const outcome = await kvService.set(
        scope,
        resolveOwner(req),
        namespace,
        key,
        body.value,
        expiresAt
      );
      if (outcome.kind === "rejected_oversize") {
        return reply.code(400).send({ error: `value exceeds the ${MAX_VALUE_BYTES}-byte limit` });
      }
      if (outcome.kind === "rejected_invalid") {
        return reply.code(400).send({ error: outcome.reason });
      }
      return reply.send({ namespace, key });
    }
  );

  app.delete(
    `${prefix}/:namespace/:key`,
    {
      preHandler: requireAuth,
      schema: {
        description: "Delete a KV entry (idempotent).",
        tags: [tag],
        security,
        params: PARAMS_NS_KEY,
        response: { 204: { type: "null" }, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (!allowed(req, reply)) return;
      const { namespace, key } = req.params as { namespace: string; key: string };
      await kvService.delete(scope, resolveOwner(req), namespace, key);
      return reply.code(204).send();
    }
  );

  app.get(
    `${prefix}/:namespace`,
    {
      preHandler: requireAuth,
      schema: {
        description: "List all live entries in a namespace.",
        tags: [tag],
        security,
        params: PARAMS_NS,
      },
    },
    async (req, reply) => {
      if (!allowed(req, reply)) return;
      const { namespace } = req.params as { namespace: string };
      const entries = await kvService.list(scope, resolveOwner(req), namespace);
      return reply.send({ entries: entries.map(toApi) });
    }
  );
}

/** Admin KV uses a separate path so user namespace `system` cannot collide with system scope. */
export function registerKvRoutes(
  app: FastifyInstance,
  kvService: KvService,
  requireAuth: PreHandler
): void {
  registerScopedKvRoutes(app, kvService, requireAuth, {
    scope: "user",
    prefix: "/api/v1/kv",
    resolveOwner: (req) => (req.user as UserDoc)._id,
    requireAdmin: false,
    tag: "kv",
  });
  registerScopedKvRoutes(app, kvService, requireAuth, {
    scope: "system",
    prefix: "/api/v1/admin/kv",
    resolveOwner: () => undefined,
    requireAdmin: true,
    tag: "kv-admin",
  });
}
