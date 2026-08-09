import type { SoulLoader } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { KnowledgeService } from "../knowledge/service";
import type { MemoryService } from "../memory/service";
import { parsePaginationQuery } from "../pagination";
import { getDefaultAssistant, resolveAgent } from "../soul/agents/registry";
import { buildSoulCatalogue } from "../soul/catalogue";
import type { BundledSkill } from "../soul/skills/bundled";
import { listAvailableSkills, listEagerSkills } from "../soul/skills/registry";
import { presentationContextFor, surfaceCatalogPromptFor } from "../surfaces/renderer-registry";
import { githubDisabledSkillNames, githubExcludedToolNames } from "../tools/github/visibility";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import type { MessageRepo } from "./messages";
import { MessageSchema } from "./schemas";
import { assembleAgentSystemPrompt } from "./system-prompt";
import { availableToolsFor, canGroundKnowledge } from "./turn-helpers";

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
  messageRepo: MessageRepo;
  memory?: MemoryService;
  knowledge?: KnowledgeService;
  soulLoader?: SoulLoader;
  toolRegistry?: ToolRegistry;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: ReadonlySet<string>;
  /** Live GitHub-install check backing per-turn tool visibility — absent only where a deployment
   * never wired the GitHub tool family at all. */
  githubStatus?: { readonly integrations: IntegrationStore; readonly businessId: string };
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: ConversationRoutesDeps,
  requireAuth: PreHandler
): void {
  const {
    repo,
    messageRepo,
    memory,
    knowledge,
    soulLoader,
    toolRegistry,
    bundledSkills,
    disabledBundledSkills,
    githubStatus,
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

  app.get(
    "/api/v1/chats/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Fetch a conversation's metadata. Owner-only.",
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
      const user = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const convo = await findOwnedConversation(repo, id, user._id);
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
      const messages = result.items;
      return reply.send({ messages, nextCursor: result.nextCursor });
    }
  );

  // Dev-only raw-state inspector backing the chat debug drawer. Returns the full persisted rows (all
  // roles incl. system/summary, tool-call/tool-result parts, metadata) PLUS the system prompt the LLM
  // receives — reconstructed via the same `assembleAgentSystemPrompt` the chat turn uses, so it cannot
  // drift from reality. The assembled prompt embeds user Memory + governance docs, so the route
  // is registered only outside production; the web app's `import.meta.env.DEV` gate does not protect an API.
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
        const user = req.user as UserDoc;
        const { id } = req.params as { id: string };
        const convo = await findOwnedConversation(repo, id, user._id);
        if (!convo) {
          return reply.code(404).send({ error: "conversation not found" });
        }
        // Reconstruct this conversation's durable system prompt with no per-turn ephemeral skills /
        // resources (there is no in-flight turn) — mirrors the chat route's front-desk assembly. Memory
        // is the conversation owner's, so the prompt matches what the LLM actually saw for this chat.
        const agent = resolveAgent(soulLoader, convo.agentId);
        const platformAgent = getDefaultAssistant(agent.name);
        const memoryAssertions = memory && convo.userId ? await memory.list(convo.userId) : [];
        const governancePages = knowledge ? await knowledge.governancePages() : [];
        const presentationContext = presentationContextFor(
          { channel: "web", surface: "chat" },
          `conversation:${id}`
        );
        const excludedTools = githubStatus
          ? await githubExcludedToolNames(githubStatus)
          : undefined;
        const skillsDisabled = githubStatus
          ? new Set([
              ...(disabledBundledSkills ?? []),
              ...(await githubDisabledSkillNames(githubStatus)),
            ])
          : disabledBundledSkills;
        const tools = availableToolsFor(
          toolRegistry,
          platformAgent,
          presentationContext,
          excludedTools
        );
        const surfaceComponents = [...(soulLoader?.surfaceComponents.values() ?? [])];
        const systemPrompt = assembleAgentSystemPrompt({
          agent,
          platformAgent,
          memory: memoryAssertions,
          governancePages,
          availableSkills: listAvailableSkills(soulLoader, bundledSkills, skillsDisabled),
          bundledSkills,
          disabledBundledSkills: skillsDisabled,
          eagerSkills: listEagerSkills(soulLoader, bundledSkills, skillsDisabled),
          taggedResources: [],
          soulCatalogue: buildSoulCatalogue(soulLoader),
          availableTools: tools,
          surfaceCatalog: surfaceCatalogPromptFor(presentationContext.target, surfaceComponents),
          knowledgeGrounding: canGroundKnowledge(knowledge, tools),
        });
        const history = await messageRepo.listByConversation(id, 1000);
        return reply.send({ conversationId: id, systemPrompt, messages: history.items });
      }
    );
  }
}
