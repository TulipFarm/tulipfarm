import type {
  MemoryAssertionView,
  MemoryExtractionService,
  MemoryLifecycleService,
  MemoryService,
  PendingMemory,
} from "@tulipfarm/memory";
import { MAX_KEY_CHARS, MAX_VALUE_CHARS } from "@tulipfarm/memory";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MemoryEntrySchema = {
  type: "object",
  required: ["assertionId", "key", "value", "writtenByAgentId", "createdAt", "lastWrittenAt"],
  properties: {
    assertionId: { type: "string" },
    key: { type: "string" },
    value: { type: "string" },
    writtenByAgentId: { type: "string", nullable: true },
    createdAt: { type: "string" },
    lastWrittenAt: { type: "string" },
  },
} as const;

function toApiEntry(e: MemoryAssertionView): Record<string, unknown> {
  return {
    assertionId: e._id,
    key: e.key,
    value: e.value,
    writtenByAgentId: e.writtenByAgentId ?? null,
    createdAt: e.createdAt.toISOString(),
    lastWrittenAt: e.lastWrittenAt.toISOString(),
  };
}

/** User-scoped Memory CRUD; writes enforce the same caps as the agent path. */
export function registerMemoryRoutes(
  app: FastifyInstance,
  service: MemoryService,
  requireAuth: PreHandler,
  extraction?: MemoryExtractionService,
  lifecycle?: MemoryLifecycleService
): void {
  if (extraction !== undefined) registerPendingMemoryRoutes(app, extraction, requireAuth);
  if (lifecycle !== undefined) registerMemoryLifecycleRoutes(app, lifecycle, service, requireAuth);

  app.get(
    "/api/v1/memory",
    {
      preHandler: requireAuth,
      schema: {
        description: "List the current user's saved Memory.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["entries", "maxValueChars"],
            properties: {
              entries: { type: "array", items: MemoryEntrySchema },
              maxValueChars: { type: "number" },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const entries = await service.list(userId);
      return reply.send({ entries: entries.map(toApiEntry), maxValueChars: MAX_VALUE_CHARS });
    }
  );

  app.put(
    "/api/v1/memory/:key",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Create or replace one of the current user's memory entries by key (upsert). New keys are user-authored preferences; editing an existing key preserves the assistant's attribution.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["value"],
          properties: {
            value: {
              type: "string",
              description: `New value. Rejected with 422 if longer than ${MAX_VALUE_CHARS} characters.`,
            },
          },
        },
        response: {
          200: MemoryEntrySchema,
          401: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const { key } = req.params as { key: string };
      const { value } = req.body as { value: string };

      if (key.length > MAX_KEY_CHARS) {
        return reply.code(422).send({ error: `key exceeds the ${MAX_KEY_CHARS}-character limit` });
      }

      // Upsert: editing an existing key keeps the assistant's attribution; a brand-new key is a
      // user-authored preference (no agent id).
      const existing = (await service.list(userId)).find((e) => e.key === key);
      const outcome = await service.update(userId, key, value, existing?.writtenByAgentId);
      if (outcome.kind === "rejected_oversize") {
        return reply
          .code(422)
          .send({ error: `value exceeds the ${MAX_VALUE_CHARS}-character limit` });
      }

      // The just-written key is eviction-protected, so it is present; the fallback only satisfies
      // the type checker.
      const saved = (await service.list(userId)).find((e) => e.key === key) ?? {
        _id: `${userId}:${key}`,
        userId,
        key,
        value,
        writtenByAgentId: existing?.writtenByAgentId,
        createdAt: existing?.createdAt ?? new Date(),
        lastWrittenAt: new Date(),
      };
      return reply.send(toApiEntry(saved));
    }
  );

  app.delete(
    "/api/v1/memory/:key",
    {
      preHandler: requireAuth,
      schema: {
        description: "Delete one of the current user's memory entries.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const { key } = req.params as { key: string };
      const deleted = await service.delete(userId, key);
      if (!deleted) {
        return reply.code(404).send({ error: "memory entry not found" });
      }
      return reply.code(204).send();
    }
  );
}

const ProceduralCorrectionSchema = {
  type: "object",
  required: ["subject", "statement"],
  additionalProperties: false,
  properties: {
    subject: {
      type: "string",
      minLength: 1,
      maxLength: MAX_KEY_CHARS,
      description: "Stable name for the correction, such as a behavior or request pattern.",
    },
    statement: {
      type: "string",
      minLength: 1,
      maxLength: MAX_VALUE_CHARS,
      description: "The explicit human correction to apply in future turns.",
    },
  },
} as const;

function isHiddenLifecycleResult(result: { outcome: string; reason?: string }): boolean {
  return (
    result.outcome === "not_found" || (result.outcome === "denied" && result.reason !== undefined)
  );
}

function registerMemoryLifecycleRoutes(
  app: FastifyInstance,
  lifecycle: MemoryLifecycleService,
  service: MemoryService,
  requireAuth: PreHandler
): void {
  app.post(
    "/api/v1/memory/corrections",
    {
      preHandler: requireAuth,
      schema: {
        description: "Record an explicit human correction as procedural Memory for future turns.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: ProceduralCorrectionSchema,
        response: {
          200: {
            type: "object",
            required: ["outcome", "assertionId"],
            properties: {
              outcome: { type: "string" },
              assertionId: { type: "string" },
            },
          },
          401: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const { subject, statement } = req.body as { subject: string; statement: string };
      const result = await lifecycle.rememberCorrection({ userId, subject, statement });
      if (result.outcome !== "saved") {
        return reply.code(422).send({ error: "procedural correction could not be saved" });
      }
      // Same cap the KV write path applies — see `MemoryService.enforceCaps`.
      await service.enforceCaps(userId, subject);
      return reply.send({ outcome: "saved", assertionId: result.assertion.assertionId });
    }
  );

  app.post(
    "/api/v1/memory/assertions/:assertionId/forget",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Forget one of the current user's Memory Assertions, leaving an auditable tombstone.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["assertionId"],
          properties: { assertionId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: { outcome: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const { assertionId } = req.params as { assertionId: string };
      const result = await lifecycle.forget(userId, assertionId);
      if (isHiddenLifecycleResult(result)) {
        return reply.code(404).send({ error: "memory assertion not found" });
      }
      return reply.send({ outcome: result.outcome });
    }
  );

  app.delete(
    "/api/v1/memory/assertions/:assertionId",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Erase one of the current user's Memory Assertions and every derived Memory copy.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["assertionId"],
          properties: { assertionId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: { outcome: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const { assertionId } = req.params as { assertionId: string };
      const result = await lifecycle.erase(userId, assertionId);
      if (isHiddenLifecycleResult(result)) {
        return reply.code(404).send({ error: "memory assertion not found" });
      }
      return reply.send({ outcome: result.outcome });
    }
  );
}

const PendingMemorySchema = {
  type: "object",
  required: ["pendingId", "subject", "statement", "memoryType", "requestedAt", "expiresAt"],
  properties: {
    pendingId: { type: "string" },
    subject: { type: "string" },
    statement: { type: "string" },
    memoryType: { type: "string" },
    confidence: { type: "number" },
    requestedAt: { type: "string" },
    expiresAt: { type: "string" },
  },
} as const;

/** Review rows hide internal target/provenance details. */
function toApiPending(p: PendingMemory): Record<string, unknown> {
  return {
    pendingId: p.pendingId,
    subject: p.request.subject,
    statement: p.request.statement,
    memoryType: p.request.memoryType ?? "fact",
    confidence: p.request.confidence,
    requestedAt: p.requestedAt,
    expiresAt: p.expiresAt,
  };
}

/** Only this user-scoped confirmation gate turns inferred candidates into Memory. */
function registerPendingMemoryRoutes(
  app: FastifyInstance,
  extraction: MemoryExtractionService,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/memory/pending",
    {
      preHandler: requireAuth,
      schema: {
        description: "List memories inferred for the current user that await confirmation.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["pending"],
            properties: { pending: { type: "array", items: PendingMemorySchema } },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const pending = await extraction.listPending(userId);
      return reply.send({ pending: pending.map(toApiPending) });
    }
  );

  app.post(
    "/api/v1/memory/pending/:pendingId",
    {
      preHandler: requireAuth,
      schema: {
        description: "Confirm or deny one inferred memory. Denial deletes it, storing nothing.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["pendingId"],
          properties: { pendingId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["decision"],
          additionalProperties: false,
          properties: { decision: { type: "string", enum: ["confirm", "deny"] } },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: { outcome: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const { pendingId } = req.params as { pendingId: string };
      const { decision } = req.body as { decision: "confirm" | "deny" };
      const result = await extraction.resolve(userId, pendingId, decision);
      // A refusal carries a reason; a decision the user actually made does not. Both a missing
      // record and one belonging to someone else answer 404, because distinguishing them would
      // confirm that a guessed pendingId exists.
      const refused = result.outcome === "denied" && result.reason !== undefined;
      if (result.outcome === "not_found" || refused) {
        return reply.code(404).send({ error: "pending memory not found" });
      }
      return reply.send({ outcome: result.outcome });
    }
  );
}
