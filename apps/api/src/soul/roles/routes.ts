/** Admin-gated REST surface over Soul-authored Roles. */

import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SoulAuditWriter } from "../../audit/soul-write";
import { ErrorSchema } from "../../auth/schemas";
import type { CapabilityCatalog } from "../../authz/capabilities";
import { makeRateLimitHook, type RateLimiter } from "../../rate-limit";
import { commitActorFromRequest } from "../commit-actor";
import {
  createLevel,
  deleteLevel,
  LevelError,
  type LevelErrorCode,
  updateLevel,
} from "./authoring";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const LEVEL_WRITE_LIMIT = 30;
const LEVEL_WRITE_WINDOW_MS = 60_000;

const requireDeploymentAdmin: PreHandler = async (req, reply) => {
  if (!req.principal) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }
  if (req.principal.kind !== "user" || req.principal.role !== "admin") {
    await reply.code(403).send({ error: "forbidden" });
  }
};

const LEVEL_STATUS: Readonly<Record<LevelErrorCode, 400 | 404 | 409>> = {
  invalid_name: 400,
  no_capabilities: 400,
  unknown_capabilities: 400,
  invalid_definition: 400,
  reserved_slug: 409,
  slug_taken: 409,
  not_found: 404,
};

const CapabilitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "action", "resourceTypes", "label", "changesThings", "tools"],
  properties: {
    id: { type: "string" },
    action: { type: "string" },
    resourceTypes: { type: "array", items: { type: "string" } },
    label: { type: "string" },
    changesThings: { type: "boolean" },
    tools: { type: "array", items: { type: "string" } },
  },
} as const;

const CatalogSchema = {
  type: "object",
  additionalProperties: false,
  required: ["areas", "unavailable"],
  properties: {
    areas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "capabilities"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          capabilities: { type: "array", items: CapabilitySchema },
        },
      },
    },
    unavailable: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "resourceTypes", "tools", "reason"],
        properties: {
          action: { type: "string" },
          resourceTypes: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const LevelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "slug", "displayName", "capabilities"],
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    displayName: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
  },
} as const;

const LevelErrorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    unknown: { type: "array", items: { type: "string" } },
  },
} as const;

export interface LevelRouteDeps {
  readonly gitSync: GitSyncService;
  readonly catalog: () => CapabilityCatalog;
  readonly reconcile: () => Promise<void>;
  /** Resolves `req.principal` before the admin gate reads it. */
  readonly requireAuth: PreHandler;
  /** Audits Role writes because Roles change authorization. */
  readonly auditWrite?: SoulAuditWriter;
  readonly rateLimiter?: RateLimiter;
}

export function registerAccessLevelRoutes(app: FastifyInstance, deps: LevelRouteDeps): void {
  const rateLimitHook = deps.rateLimiter
    ? makeRateLimitHook(
        deps.rateLimiter,
        (req) => `rl:levels:${req.ip}`,
        LEVEL_WRITE_LIMIT,
        LEVEL_WRITE_WINDOW_MS
      )
    : undefined;
  const readHandlers: PreHandler[] = [deps.requireAuth, requireDeploymentAdmin];
  const writeHandlers: PreHandler[] = rateLimitHook
    ? [rateLimitHook, deps.requireAuth, requireDeploymentAdmin]
    : [deps.requireAuth, requireDeploymentAdmin];

  function sendLevelError(reply: FastifyReply, error: LevelError) {
    return reply.code(LEVEL_STATUS[error.code]).send({
      error: error.message,
      code: error.code,
      ...(error.unknown.length === 0 ? {} : { unknown: error.unknown }),
    });
  }

  app.get(
    "/api/v1/authz/capabilities",
    {
      preHandler: readHandlers,
      schema: {
        description:
          "Everything this deployment can grant, named in plain language and grouped by area. " +
          "Derived from the live Tool registry, so it cannot offer an action the gate would not " +
          "evaluate. `unavailable` names capabilities a Tool requires that an authored access " +
          "level cannot express, rather than hiding them.",
        tags: ["authz"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: CatalogSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async () => deps.catalog()
  );

  app.post(
    "/api/v1/authz/levels",
    {
      preHandler: writeHandlers,
      schema: {
        description:
          "Create an access level. Written as a Soul Role at soul/roles/{slug}/role.yaml, " +
          "committed, and projected into the durable role rows the gate reads. Every capability " +
          "must come from GET /api/v1/authz/capabilities.",
        tags: ["authz"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["name", "capabilities"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 256 },
            capabilities: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          },
        },
        response: {
          201: LevelSchema,
          400: LevelErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: LevelErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { name: string; capabilities: string[] };
      try {
        const level = await createLevel(
          { name: body.name, capabilities: body.capabilities },
          { gitSync: deps.gitSync, catalog: deps.catalog, reconcile: deps.reconcile },
          commitActorFromRequest(req)
        );
        await deps.auditWrite?.(req, "authz.level.create", `authz-level:${level.slug}`, {
          capabilities: level.capabilities.length,
        });
        return reply.code(201).send(level);
      } catch (error) {
        if (error instanceof LevelError) return sendLevelError(reply, error);
        throw error;
      }
    }
  );

  app.patch(
    "/api/v1/authz/levels/:slug",
    {
      preHandler: writeHandlers,
      schema: {
        description:
          "Replace an access level's name and capabilities. The level keeps its identity, so " +
          "everybody already holding it keeps holding it — which is what makes this different " +
          "from deleting and re-creating. The slug never changes, even when the name does.",
        tags: ["authz"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["name", "capabilities"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 256 },
            capabilities: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          },
        },
        response: {
          200: LevelSchema,
          400: LevelErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: LevelErrorSchema,
          409: LevelErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const body = req.body as { name: string; capabilities: string[] };
      try {
        const level = await updateLevel(
          slug,
          { name: body.name, capabilities: body.capabilities },
          { gitSync: deps.gitSync, catalog: deps.catalog, reconcile: deps.reconcile },
          commitActorFromRequest(req)
        );
        await deps.auditWrite?.(req, "authz.level.update", `authz-level:${slug}`, {
          capabilities: level.capabilities.length,
        });
        return reply.code(200).send(level);
      } catch (error) {
        if (error instanceof LevelError) return sendLevelError(reply, error);
        throw error;
      }
    }
  );

  app.delete(
    "/api/v1/authz/levels/:slug",
    {
      preHandler: writeHandlers,
      schema: {
        description:
          "Delete an access level. Removes the Soul artifact and commits; the reconciler then " +
          "reaps the durable row, which cascades to every assignment of it. Built-in levels " +
          "cannot be deleted.",
        tags: ["authz"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string", minLength: 1 } },
        },
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          403: ErrorSchema,
          404: LevelErrorSchema,
          409: LevelErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      try {
        await deleteLevel(
          slug,
          { gitSync: deps.gitSync, catalog: deps.catalog, reconcile: deps.reconcile },
          commitActorFromRequest(req)
        );
        await deps.auditWrite?.(req, "authz.level.delete", `authz-level:${slug}`);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof LevelError) return sendLevelError(reply, error);
        throw error;
      }
    }
  );
}
