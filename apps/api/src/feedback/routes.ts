import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { FeedbackRating, FeedbackRepo } from "./repo";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NOTE_MAX = 500;

/**
 * Per-message feedback routes (FB-V1). Capture layer only — a thumbs up/down (with an optional
 * down-vote note) per (message, user). `conversation_id` is derived server-side from the message;
 * the GET returns only the caller's own votes (no cross-user visibility).
 */
export function registerFeedbackRoutes(
  app: FastifyInstance,
  feedbackRepo: FeedbackRepo,
  requireAuth: PreHandler
): void {
  app.post(
    "/api/v1/messages/:messageId/feedback",
    {
      preHandler: requireAuth,
      schema: {
        description: "Set (or replace) the caller's thumbs up/down on an assistant message.",
        tags: ["feedback"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["messageId"],
          properties: { messageId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["rating"],
          additionalProperties: false,
          properties: {
            rating: { type: "string", enum: ["up", "down"] },
            note: { type: "string", maxLength: NOTE_MAX },
          },
        },
        response: {
          200: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { messageId } = req.params as { messageId: string };
      const { rating, note } = req.body as { rating: FeedbackRating; note?: string };
      const trimmed = note?.trim();
      const ok = await feedbackRepo.upsert({
        id: randomUUID(),
        messageId,
        userId: user._id,
        rating,
        note: trimmed ? trimmed : null,
      });
      if (!ok) return reply.code(404).send({ error: "message not found" });
      return reply.send({ status: "ok" });
    }
  );

  app.delete(
    "/api/v1/messages/:messageId/feedback",
    {
      preHandler: requireAuth,
      schema: {
        description: "Clear the caller's thumbs up/down on a message (idempotent).",
        tags: ["feedback"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["messageId"],
          properties: { messageId: { type: "string", minLength: 1 } },
        },
        response: {
          200: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { messageId } = req.params as { messageId: string };
      await feedbackRepo.clear(messageId, user._id);
      return reply.send({ status: "ok" });
    }
  );

  app.get(
    "/api/v1/conversations/:id/feedback",
    {
      preHandler: requireAuth,
      schema: {
        description: "List the caller's message votes for a conversation (rehydrates thumb state).",
        tags: ["feedback"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["feedback"],
            properties: {
              feedback: {
                type: "array",
                items: {
                  type: "object",
                  required: ["messageId", "rating"],
                  properties: {
                    messageId: { type: "string" },
                    rating: { type: "string", enum: ["up", "down"] },
                    note: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const feedback = await feedbackRepo.listByConversation(id, user._id);
      return reply.send({ feedback });
    }
  );
}
