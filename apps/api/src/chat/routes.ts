import { randomUUID } from "node:crypto";
import { LlmNotConfiguredError, type LlmService, UnknownModelError } from "@tulipfarm/llm";
import { type CoreMessage, streamText } from "ai";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { parsePaginationQuery } from "../pagination";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import { type MessageRepo, fromAssistantText, fromUserText, toCoreMessage } from "./messages";
import { MessageSchema } from "./schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface ChatBody {
  conversationId?: string;
  message: { role: "user"; content: string };
  model?: string;
  agentId?: string;
  autonomy?: "full" | "supervised" | "approval-required" | "manual";
  hasTools?: boolean;
  llmDecision?: boolean;
}

const ChatBodySchema = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    conversationId: { type: "string" },
    message: {
      type: "object",
      required: ["role", "content"],
      additionalProperties: false,
      properties: {
        role: { type: "string", enum: ["user"] },
        content: { type: "string", minLength: 1 },
      },
    },
    model: { type: "string", minLength: 1, pattern: "^\\S+$" },
    agentId: { type: "string", minLength: 1 },
    autonomy: { type: "string", enum: ["full", "supervised", "approval-required", "manual"] },
    hasTools: { type: "boolean" },
    llmDecision: { type: "boolean" },
  },
} as const;

/** Per-turn observability record (AC4): which model served the turn and whether an override applied. */
export function buildTurnLog(args: {
  conversationId: string;
  userId: string;
  requestedModel: string | undefined;
  resolvedModelId: string;
  isNewConversation: boolean;
}): {
  conversationId: string;
  userId: string;
  requestedModel: string | null;
  overrideApplied: boolean;
  resolvedModelId: string;
  isNewConversation: boolean;
} {
  return {
    conversationId: args.conversationId,
    userId: args.userId,
    requestedModel: args.requestedModel ?? null,
    overrideApplied: args.requestedModel != null,
    resolvedModelId: args.resolvedModelId,
    isNewConversation: args.isNewConversation,
  };
}

export function registerChatRoutes(
  app: FastifyInstance,
  llmService: LlmService,
  repo: ConversationRepo,
  messageRepo: MessageRepo,
  requireAuth: PreHandler
): void {
  app.post(
    "/api/v1/chat",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Run one chat turn (streamed, AI SDK data-stream protocol). An optional `model` " +
          "(tier name or model id) overrides the model for this turn only; it is never persisted.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: ChatBodySchema,
        response: { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 503: ErrorSchema },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const body = req.body as ChatBody;

      // 1. Load or create the conversation (before any streaming).
      let convo: ConversationDoc;
      let isNew: boolean;
      if (body.conversationId) {
        const found = await repo.findById(body.conversationId);
        if (!found || found.userId !== user._id) {
          return reply.code(404).send({ error: "conversation not found" });
        }
        convo = found;
        isNew = false;
      } else {
        const now = new Date();
        convo = {
          _id: randomUUID(),
          userId: user._id,
          agentId: body.agentId,
          model: undefined,
          createdAt: now,
          updatedAt: now,
        };
        await repo.create(convo);
        isNew = true;
      }

      // 2. Resolve the model synchronously so a bad request returns before headers go out.
      //    sessionModel = per-turn override (ephemeral); model = conversation default (persisted).
      let selected: ReturnType<LlmService["select"]>;
      try {
        selected = llmService.select({
          sessionModel: body.model,
          model: convo.model,
          autonomy: body.autonomy,
          hasTools: body.hasTools,
          llmDecision: body.llmDecision,
        });
      } catch (err) {
        if (err instanceof UnknownModelError) return reply.code(400).send({ error: err.message });
        if (err instanceof LlmNotConfiguredError)
          return reply.code(503).send({ error: err.message });
        throw err;
      }

      // 3. Per-turn observability log (AC4).
      req.log.info(
        buildTurnLog({
          conversationId: convo._id,
          userId: user._id,
          requestedModel: body.model,
          resolvedModelId: selected.modelId,
          isNewConversation: isNew,
        }),
        "chat turn"
      );

      // 4. Build history + persist the user turn (survives an aborted stream).
      const history = await messageRepo.listByConversation(convo._id, 1000);
      const messages: CoreMessage[] = [
        ...history.items.map(toCoreMessage),
        { role: "user", content: body.message.content },
      ];
      await messageRepo.create(fromUserText(convo._id, body.message.content));
      await repo.touch(convo._id);

      // 5. Stream the assistant reply; persist it only on successful finish.
      if (isNew) reply.raw.setHeader("X-Conversation-Id", convo._id);
      reply.hijack();

      const result = streamText({
        model: selected,
        messages,
        onError: ({ error }) => {
          req.log.error({ err: error, conversationId: convo._id }, "chat stream error");
        },
        onFinish: async ({ text, finishReason }) => {
          if (finishReason === "error") return;
          if (!text) {
            req.log.info(
              { conversationId: convo._id, finishReason },
              "assistant turn produced no text — skipping persist"
            );
            return;
          }
          await messageRepo
            .create(fromAssistantText(convo._id, text))
            .catch((e) => req.log.error({ err: e, conversationId: convo._id }, "persist failed"));
        },
      });

      result.pipeDataStreamToResponse(reply.raw, {
        getErrorMessage: (e) => (e instanceof Error ? e.message : "stream error"),
      });
    }
  );

  app.get(
    "/api/v1/conversations/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Fetch a conversation's metadata (tenant-open: any authenticated user).",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              userId: { type: ["string", "null"] },
              agentId: { type: ["string", "null"] },
              model: { type: ["string", "null"] },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
            required: ["id", "createdAt", "updatedAt"],
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const convo = await repo.findById(id);
      if (!convo) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      return reply.send({
        id: convo._id,
        userId: convo.userId ?? null,
        agentId: convo.agentId ?? null,
        model: convo.model ?? null,
        createdAt: convo.createdAt,
        updatedAt: convo.updatedAt,
      });
    }
  );

  app.get(
    "/api/v1/conversations/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List a conversation's messages, oldest→newest, cursor-paginated " +
          "(tenant-open: any authenticated user).",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              messages: { type: "array", items: MessageSchema },
              nextCursor: { type: ["string", "null"] },
            },
            required: ["messages", "nextCursor"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const convo = await repo.findById(id);
      if (!convo) {
        return reply.code(404).send({ error: "conversation not found" });
      }

      const { limit, after } = parsePaginationQuery(req.query as Record<string, unknown>);
      const rawCursor = (req.query as Record<string, unknown>).cursor;
      if (typeof rawCursor === "string" && rawCursor !== "" && after === undefined) {
        return reply.code(400).send({ error: "invalid cursor" });
      }

      const result = await messageRepo.listByConversation(id, limit, after);
      return reply.send({ messages: result.items, nextCursor: result.nextCursor });
    }
  );
}
