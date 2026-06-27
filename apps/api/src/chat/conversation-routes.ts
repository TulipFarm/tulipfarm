import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { KnowledgeService } from "../knowledge/service";
import type { WorkingMemoryService } from "../memory/service";
import { parsePaginationQuery } from "../pagination";
import { getPlatformAgent, resolveAgent } from "../soul/agents/registry";
import { buildSoulCatalogue } from "../soul/catalogue";
import { listAvailableSkills, listEagerSkills } from "../soul/skills/registry";
import type { ToolRegistry } from "../tools/registry";
import type { ConversationRepo } from "./conversations";
import type { MessageRepo } from "./messages";
import { MessageSchema } from "./schemas";
import { assembleAgentSystemPrompt } from "./system-prompt";
import { availableToolsFor, canGroundKnowledge } from "./turn-helpers";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Read/update routes over conversation metadata + messages (no streaming). */
export interface ConversationRoutesDeps {
  repo: ConversationRepo;
  messageRepo: MessageRepo;
  workingMemory?: WorkingMemoryService;
  knowledge?: KnowledgeService;
  soulLoader?: SoulLoader;
  toolRegistry?: ToolRegistry;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: ConversationRoutesDeps,
  requireAuth: PreHandler
): void {
  const { repo, messageRepo, workingMemory, knowledge, soulLoader, toolRegistry } = deps;

  app.get(
    "/api/v1/conversations",
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
    "/api/v1/conversations/:id",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Update a conversation's title (rename) and/or starred flag. Owner-only. At least one " +
          "field is required.",
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
            title: { type: "string", minLength: 1, maxLength: 200 },
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

      // Owner-only mutation (unlike the tenant-open reads): a non-owner — or a missing id — is a 404.
      const convo = await repo.findById(id);
      if (!convo || convo.userId !== user._id) {
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
              title: { type: ["string", "null"] },
              starred: { type: "boolean" },
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
        title: convo.title ?? null,
        starred: convo.starred ?? false,
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

  // Dev-only raw-state inspector backing the chat debug drawer. Returns the full persisted rows (all
  // roles incl. system/summary, tool-call/tool-result parts, metadata) PLUS the system prompt the LLM
  // receives — reconstructed via the same `assembleAgentSystemPrompt` the chat turn uses, so it cannot
  // drift from reality. The assembled prompt embeds user working-memory + governance docs, so the route
  // is registered only outside production; the web app's `import.meta.env.DEV` gate does not protect an API.
  if (process.env.NODE_ENV !== "production") {
    app.get(
      "/api/v1/conversations/:id/debug-context",
      {
        preHandler: requireAuth,
        schema: {
          description:
            "Dev-only: a conversation's reconstructed system prompt + full raw message rows " +
            "(not registered in production).",
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
                messages: { type: "array", items: MessageSchema },
              },
              required: ["conversationId", "systemPrompt", "messages"],
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
        // Reconstruct this conversation's durable system prompt with no per-turn ephemeral skills /
        // resources (there is no in-flight turn) — mirrors the chat route's front-desk assembly. Memory
        // is the conversation owner's, so the prompt matches what the LLM actually saw for this chat.
        const agent = resolveAgent(soulLoader, convo.agentId);
        const platformAgent = getPlatformAgent(agent.name);
        const memory = workingMemory && convo.userId ? await workingMemory.list(convo.userId) : [];
        const governanceDocs = knowledge ? await knowledge.governanceDocuments() : [];
        const tools = availableToolsFor(toolRegistry, platformAgent);
        const systemPrompt = assembleAgentSystemPrompt({
          agent,
          platformAgent,
          memory,
          governanceDocs,
          availableSkills: listAvailableSkills(soulLoader),
          eagerSkills: listEagerSkills(soulLoader),
          taggedResources: [],
          soulCatalogue: buildSoulCatalogue(soulLoader),
          availableTools: tools,
          knowledgeGrounding: canGroundKnowledge(knowledge, tools),
        });
        const history = await messageRepo.listByConversation(id, 1000);
        return reply.send({ conversationId: id, systemPrompt, messages: history.items });
      }
    );
  }
}
