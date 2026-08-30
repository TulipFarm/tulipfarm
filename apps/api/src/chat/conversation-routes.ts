import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FileService } from "@tulipfarm/files";
import { CHAT_TITLE_MAX_LENGTH, ConversationDetailSchema } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import { resolveAgent } from "@tulipfarm/soul";
import { parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { ConversationStore } from "../conversations/service";
import {
  type MemoryDocumentReader,
  resolveSoulReminder,
  type SubjectAuthorityLayers,
} from "../soul/reminder";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import { type MessageRepo, referencedFileIds, withUnavailableFiles } from "./messages";
import { MessageSchema } from "./schemas";
import { assembleAgentSystemPrompt } from "./system-prompt";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Owner-scoped conversation lookup: a foreign conversation is treated identically to a
 * missing one (404), so a caller can't distinguish "not found" from "not yours".
 */
async function findOwnedConversation(
  repo: ConversationRepo,
  id: string,
  userId: string
): Promise<ConversationDoc | null> {
  const convo = await repo.findById(id);
  if (!convo || convo.userId !== userId) return null;
  return convo;
}

/** Read/update routes over conversation metadata + messages (no streaming). */
export interface ConversationRoutesDeps {
  repo: ConversationRepo;
  turnStore?: Pick<ConversationStore, "findLatestTurn">;
  messageRepo: MessageRepo;
  /**
   * Resolves which attached Files the reader can still open, so a transcript can render a
   * destroyed or un-shared attachment as removed rather than as a broken image. Absent only where
   * a deployment runs without Files at all, in which case every attachment renders as removed —
   * which is the truthful answer there too.
   */
  files?: Pick<FileService, "presentFor">;
  soulLoader?: SoulLoader;
  /**
   * Lets `debug-context` narrow the Soul reminder the same way a Turn does. Absent means the
   * view reports an empty reminder, which is also what a Turn would send.
   */
  authorityLayers?: SubjectAuthorityLayers;
  /** Fed to the reminder so the drawer shows the same personal blocks the Turn sends. */
  memory?: MemoryDocumentReader;
  customInstructions?: (userId: string) => Promise<string | undefined>;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: ConversationRoutesDeps,
  requireAuth: PreHandler
): void {
  const {
    repo,
    messageRepo,
    soulLoader,
    files,
    turnStore,
    authorityLayers,
    memory,
    customInstructions,
  } = deps;

  app.get(
    "/api/v1/chats",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List the authenticated user's conversations, newest-first (Recent chats + Chats page). " +
          "`q` filters by title (case-insensitive substring); `limit` defaults to 50 (max 200).",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              conversations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: ["string", "null"] },
                    agentId: { type: ["string", "null"] },
                    starred: { type: "boolean" },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
                  },
                  required: ["id", "title", "agentId", "starred", "createdAt", "updatedAt"],
                },
              },
            },
            required: ["conversations"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { q, limit } = req.query as { q?: string; limit?: number };
      const convos = await repo.list(user._id, Math.min(limit ?? 50, 200), q?.trim() || undefined);
      return reply.send({
        conversations: convos.map((c) => ({
          id: c._id,
          title: c.title ?? null,
          agentId: c.agentId ?? null,
          starred: c.starred ?? false,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      });
    }
  );

  app.put(
    "/api/v1/chats/:id",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Update a conversation's title (rename) and/or starred flag. Owner-only. At least one " +
          `field is required. A title is trimmed and may not exceed ${CHAT_TITLE_MAX_LENGTH} characters.`,
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: "string", minLength: 1, maxLength: CHAT_TITLE_MAX_LENGTH },
            starred: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: ["string", "null"] },
              agentId: { type: ["string", "null"] },
              starred: { type: "boolean" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
            required: ["id", "title", "agentId", "starred", "createdAt", "updatedAt"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const body = req.body as { title?: string; starred?: boolean };

      const convo = await findOwnedConversation(repo, id, user._id);
      if (!convo) {
        return reply.code(404).send({ error: "conversation not found" });
      }

      if (body.title !== undefined) {
        const title = body.title.trim();
        if (title === "") return reply.code(400).send({ error: "title must not be blank" });
        await repo.setTitle(id, title);
      }
      if (body.starred !== undefined) await repo.setStarred(id, body.starred);

      const updated = await repo.findById(id);
      if (!updated) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      return reply.send({
        id: updated._id,
        title: updated.title ?? null,
        agentId: updated.agentId ?? null,
        starred: updated.starred ?? false,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    }
  );

  app.delete(
    "/api/v1/chats/:id",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Permanently delete an owned conversation and its persisted Chat data. Refuses while " +
          "a Turn is pending or running.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const outcome = await repo.deleteOwned(id, user._id);
      if (outcome === "not_found") {
        return reply.code(404).send({ error: "conversation not found" });
      }
      if (outcome === "active_turn") {
        return reply.code(409).send({
          error: "This chat has a Turn in progress. Wait for it to finish before deleting.",
        });
      }
      return reply.code(204).send();
    }
  );

  app.get(
    "/api/v1/chats/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Fetch a conversation's metadata and latest Turn for Chat restoration.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: ConversationDetailSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const convo = await findOwnedConversation(repo, id, user._id);
      if (!convo) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      const latestTurn = await turnStore?.findLatestTurn(DEPLOYMENT_BUSINESS_ID, id);
      return reply.send({
        id: convo._id,
        userId: convo.userId ?? null,
        agentId: convo.agentId ?? null,
        model: convo.model ?? null,
        title: convo.title ?? null,
        starred: convo.starred ?? false,
        createdAt: convo.createdAt,
        updatedAt: convo.updatedAt,
        latestTurn: latestTurn
          ? { id: latestTurn.id, runId: latestTurn.runId, status: latestTurn.status }
          : null,
      });
    }
  );

  app.get(
    "/api/v1/chats/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        description: "List a conversation's messages, oldest→newest, cursor-paginated. Owner-only.",
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
      const user = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const convo = await findOwnedConversation(repo, id, user._id);
      if (!convo) {
        return reply.code(404).send({ error: "conversation not found" });
      }

      const { limit, after } = parsePaginationQuery(req.query as Record<string, unknown>);
      const rawCursor = (req.query as Record<string, unknown>).cursor;
      if (typeof rawCursor === "string" && rawCursor !== "" && after === undefined) {
        return reply.code(400).send({ error: "invalid cursor" });
      }

      const result = await messageRepo.listByConversation(id, limit, after);
      // Asked once for the whole page rather than per attachment: an old Chat can name a dozen
      // Files, and a query each would make scrolling back through it cost more than reading it.
      const present = files
        ? await files.presentFor(DEPLOYMENT_BUSINESS_ID, user._id, referencedFileIds(result.items))
        : new Set<string>();
      const messages = withUnavailableFiles(result.items, present);
      return reply.send({ messages, nextCursor: result.nextCursor });
    }
  );

  // Dev-only raw-state inspector backing the chat debug drawer. Returns the full persisted rows (all
  // roles incl. system/summary, tool-call/tool-result parts, metadata) PLUS the system prompt the LLM
  // receives — reconstructed via the same `assembleAgentSystemPrompt` the chat turn uses, so it cannot
  // drift from reality. Those rows carry whatever the conversation said, so the route is registered
  // only outside production; the web app's `import.meta.env.DEV` gate does not protect an API.
  if (process.env.NODE_ENV !== "production") {
    app.get(
      "/api/v1/chats/:id/debug-context",
      {
        preHandler: requireAuth,
        schema: {
          description:
            "Dev-only: a conversation's reconstructed system prompt + full raw message rows. " +
            "Owner-only (not registered in production).",
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
                conversationId: { type: "string" },
                systemPrompt: { type: "string" },
                soulReminder: { type: "string" },
                messages: { type: "array", items: MessageSchema },
              },
              required: ["conversationId", "systemPrompt", "soulReminder", "messages"],
            },
            401: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const user = req.user as UserDoc;
        const { id } = req.params as { id: string };
        const convo = await findOwnedConversation(repo, id, user._id);
        if (!convo) {
          return reply.code(404).send({ error: "conversation not found" });
        }
        const agent = resolveAgent(soulLoader, convo.agentId);
        const systemPrompt = assembleAgentSystemPrompt({ agent });
        const soulReminder = await resolveSoulReminder({
          ...(authorityLayers === undefined ? {} : { authorityLayers }),
          ...(soulLoader === undefined ? {} : { soulLoader }),
          ...(memory === undefined ? {} : { memory }),
          ...(customInstructions === undefined ? {} : { customInstructions }),
          businessId: DEPLOYMENT_BUSINESS_ID,
          subjectId: user._id,
          subjectKind: "user",
          now: new Date(),
        });
        const history = await messageRepo.listByConversation(id, 1000);
        return reply.send({
          conversationId: id,
          systemPrompt,
          soulReminder,
          messages: history.items,
        });
      }
    );
  }
}
