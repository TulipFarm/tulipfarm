import type { EventEmitter } from "node:events";
import type { LlmService } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type A2uiSurfaceStore, MemoryA2uiSurfaceStore } from "../a2ui/surface-store";
import { ErrorSchema } from "../auth/schemas";
import type { GuardrailsService } from "../guardrails";
import type { KnowledgeService } from "../knowledge/service";
import type { WorkingMemoryService } from "../memory/service";
import type { ToolRegistry } from "../tools/registry";
import { ApprovalRegistry } from "./approvals";
import { registerConversationRoutes } from "./conversation-routes";
import type { ConversationRepo } from "./conversations";
import type { MessageRepo } from "./messages";
import { MemoryPendingInteractionRepo, type PendingInteractionRepo } from "./pending-interactions";
import { attachToStream } from "./producer";
import { writeSseHeaders } from "./sse";
import type { StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";
import { type ChatTurnContext, runChatTurn } from "./turn";
import { ChatBodySchema, corsPassthrough, parseLastEventId } from "./turn-helpers";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerChatRoutes(
  app: FastifyInstance,
  llmService: LlmService,
  repo: ConversationRepo,
  messageRepo: MessageRepo,
  streamRepo: StreamResumeRepo,
  hub: StreamHub,
  requireAuth: PreHandler,
  workingMemory?: WorkingMemoryService,
  knowledge?: KnowledgeService,
  soulLoader?: SoulLoader,
  events?: EventEmitter,
  toolRegistry?: ToolRegistry,
  approvals?: ApprovalRegistry,
  guardrails?: GuardrailsService,
  pendingInteractionRepo?: PendingInteractionRepo,
  a2uiSurfaceStore?: A2uiSurfaceStore
): void {
  // One in-process approval registry shared by the chat turn (which suspends gated tools) and the
  // decide route (which resolves them). Single-instance V1 — see chat/approvals.ts.
  const approvalRegistry = approvals ?? new ApprovalRegistry();
  // HITL suspend/resume store (A2UI ask_user). Defaults to in-memory like the approval registry; the
  // Postgres-backed repo is injected by buildApp so pauses survive restarts.
  const pendingInteractions = pendingInteractionRepo ?? new MemoryPendingInteractionRepo();
  // A2UI live-surface store: render_surface persists each surface; update_surface diffs + swaps it.
  const surfaceStore = a2uiSurfaceStore ?? new MemoryA2uiSurfaceStore();
  // In-flight turns keyed by streamId, so the stop endpoint can abort the LLM mid-stream. Each entry
  // is removed when its producer settles (single-instance V1, mirroring the approval registry).
  const streamControllers = new Map<string, AbortController>();

  const turnCtx: ChatTurnContext = {
    llmService,
    repo,
    messageRepo,
    streamRepo,
    hub,
    workingMemory,
    knowledge,
    soulLoader,
    events,
    toolRegistry,
    guardrails,
    approvalRegistry,
    pendingInteractions,
    surfaceStore,
    streamControllers,
  };

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
    async (req, reply) => runChatTurn(req, reply, turnCtx)
  );

  app.post(
    "/api/v1/chat/streams/:streamId/stop",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Stop an in-flight chat stream: aborts the LLM so generation halts immediately. The " +
          "producer ends the stream with a `finish` (reason `stopped`). 404 if the stream already " +
          "finished or never existed.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["streamId"],
          properties: { streamId: { type: "string", minLength: 1 } },
        },
        response: {
          200: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { streamId } = req.params as { streamId: string };
      const controller = streamControllers.get(streamId);
      if (!controller) {
        return reply.code(404).send({ error: "stream not found or already finished" });
      }
      controller.abort();
      return reply.send({ status: "stopped" });
    }
  );

  app.get(
    "/api/v1/chat/streams/:streamId",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Resume an in-flight or recently-finished chat stream over SSE. Send the last " +
          "received event id as the `Last-Event-ID` header (or `?lastEventId=`): buffered " +
          "events after it are replayed, then the connection attaches to the live tail.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["streamId"],
          properties: { streamId: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { lastEventId: { type: "integer", minimum: 0 } },
        },
        response: { 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { streamId } = req.params as { streamId: string };
      const afterSeq = parseLastEventId(
        req.headers["last-event-id"],
        (req.query as { lastEventId?: number }).lastEventId
      );

      // Unknown stream (never existed or already GC'd) → 404. A live stream or any
      // buffered row counts as known, even if the client already has every event.
      if (!hub.isLive(streamId)) {
        const existing = await streamRepo.listAfter(streamId, 0);
        if (existing.length === 0) {
          return reply.code(404).send({ error: "stream not found" });
        }
      }

      writeSseHeaders(reply.raw, corsPassthrough(reply));
      reply.hijack();
      await attachToStream(reply.raw, streamId, afterSeq, { repo: streamRepo, hub });
    }
  );

  registerConversationRoutes(
    app,
    { repo, messageRepo, workingMemory, knowledge, soulLoader, toolRegistry },
    requireAuth
  );
}
