import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { MAX_KEY_CHARS, MAX_VALUE_CHARS } from "./limits";
import type { WorkingMemoryService } from "./service";
import type { WorkingMemoryDoc } from "./working-memory";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MemoryEntrySchema = {
  type: "object",
  required: ["key", "value", "writtenByAgentId", "createdAt", "lastWrittenAt"],
  properties: {
    key: { type: "string" },
    value: { type: "string" },
    writtenByAgentId: { type: "string", nullable: true },
    createdAt: { type: "string" },
    lastWrittenAt: { type: "string" },
  },
} as const;

function toApiEntry(e: WorkingMemoryDoc): Record<string, unknown> {
  return {
    key: e.key,
    value: e.value,
    writtenByAgentId: e.writtenByAgentId ?? null,
    createdAt: e.createdAt.toISOString(),
    lastWrittenAt: e.lastWrittenAt.toISOString(),
  };
}

/**
 * User-facing CRUD over the caller's own working memory (the `<memory>` facts the assistant
 * saves, plus preferences the user sets). List + upsert (`PUT` creates or replaces by key) +
 * delete. The per-entry caps (`MAX_KEY_CHARS`, `MAX_VALUE_CHARS`) are enforced on writes, same
 * as the agent write path; everything is scoped to the authenticated user.
 */
export function registerMemoryRoutes(
  app: FastifyInstance,
  service: WorkingMemoryService,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/memory",
    {
      preHandler: requireAuth,
      schema: {
        description: "List the current user's saved working-memory entries.",
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
