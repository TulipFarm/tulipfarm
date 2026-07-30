import type { EventEmitter } from "node:events";
import type { LlmService } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DurableApprovalGate } from "../approvals/chat-gate";
import { ErrorSchema } from "../auth/schemas";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { ConversationStore } from "../conversations/service";
import type { GuardrailsService } from "../guardrails";
import type { KnowledgeService } from "../knowledge/service";
import type { WorkingMemoryService } from "../memory/service";
import { type ChatTurnContext, type ChatTurnSubmitter, runChatTurn } from "../runtime/chat-run";
import type { ChatRunLifecycle } from "../runtime/chat-run-lifecycle";
import type { DurableInvocationGateway } from "../runtime/invocation-gateway";
import type { BundledSkill } from "../soul/skills/bundled";
import type { SurfaceActionStore } from "../surfaces/action-store";
import { MemorySurfaceArtifactStore, type SurfaceArtifactStore } from "../surfaces/artifact-store";
import { registerConversationRoutes } from "./conversation-routes";
import type { ConversationRepo } from "./conversations";
import type { MessageRepo } from "./messages";
import { MemoryPendingInteractionRepo, type PendingInteractionRepo } from "./pending-interactions";
import { attachToStream } from "./producer";
import { writeSseHeaders } from "./sse";
import type { StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";
import { ChatBodySchema, corsPassthrough, parseLastEventId } from "./turn-helpers";
import { durableTurnSubmitter, messageOnlySubmitter } from "./turn-submit";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 409 body for a replayed request: the Run that already answers it, so the client can reattach. */
const DuplicateInvocationSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" }, runId: { type: "string" } },
} as const;

declare module "fastify" {
  interface FastifyInstance {
    /** Set by registerChatRoutes — the shared turn context headless callers reuse. */
    chatTurnContext?: ChatTurnContext;
  }
}

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
  approvals?: DurableApprovalGate,
  guardrails?: GuardrailsService,
  pendingInteractionRepo?: PendingInteractionRepo,
  injectedSurfaceStore?: SurfaceArtifactStore,
  surfaceActionStore?: SurfaceActionStore,
  invocations?: DurableInvocationGateway,
  bundledSkills?: ReadonlyMap<string, BundledSkill>,
  disabledBundledSkills?: ReadonlySet<string>,
  chatRunLifecycle?: ChatRunLifecycle,
  conversationStore?: ConversationStore
): void {
  // A gateway with nowhere to record the Turn would mint Runs whose requests are unreachable — the
  // exact hole this submission path closes. Refuse to boot half-wired rather than degrade silently.
  if (invocations && !conversationStore) {
    throw new Error("chat_routes_missing_conversation_store");
  }
  // One approval gate shared by the chat turn and decision route. Production injects its
  // authoritative PostgreSQL repository; process-local waiters only resume the live stream.
  const approvalRegistry = approvals ?? new DurableApprovalGate();
  // HITL suspend/resume store. Tests may use the in-memory default; buildApp injects
  // the PostgreSQL-backed repository so production pauses survive restarts.
  const pendingInteractions = pendingInteractionRepo ?? new MemoryPendingInteractionRepo();
  const surfaceStore = injectedSurfaceStore ?? new MemorySurfaceArtifactStore();
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
    bundledSkills,
    disabledBundledSkills,
    events,
    toolRegistry,
    guardrails,
    approvalRegistry,
    pendingInteractions,
    surfaceStore,
    surfaceActionStore,
    streamControllers,
  };
  // Expose the turn context so headless callers (integration ingress worker, wired in index.ts)
  // run through exactly the same pipeline as the HTTP route.
  app.decorate("chatTurnContext", turnCtx);

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
        // The key a replayed turn is deduplicated by. Bounded because it is stored verbatim as the
        // Turn's identity — an unbounded client value would reach the database as-is.
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: ChatBodySchema,
        response: {
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: DuplicateInvocationSchema,
          503: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!(invocations && conversationStore)) {
        return runChatTurn(req, reply, turnCtx, messageOnlySubmitter(messageRepo));
      }
      const principal = req.principal;
      if (!principal) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const idempotencyHeader = req.headers["idempotency-key"];
      // A client that sends no key still gets idempotency, just only within its own retry of this
      // request — `req.id` is unique per delivery, so a second POST is a second Turn.
      const clientKey =
        typeof idempotencyHeader === "string" && idempotencyHeader.length > 0
          ? idempotencyHeader
          : req.id;
      const durable = durableTurnSubmitter({
        store: conversationStore,
        invocations,
        principal: { kind: principal.kind, id: principal.id, businessId: principal.businessId },
        payload: req.body,
        agentId: (req.body as { agentId?: string }).agentId ?? "assistant",
        // Scoped to the submitter. Turn keys are unique deployment-wide, and the value is whatever a
        // client chose to send, so an unscoped key lets one caller claim another's: their turn would
        // be refused as a duplicate and answered with a Run id that is not theirs.
        idempotencyKey: `${principal.kind}:${principal.id}:${clientKey}`,
        ...(chatRunLifecycle ? { lifecycle: chatRunLifecycle } : {}),
        log: req.log,
      });
      // The chat response is hijacked for SSE below, so the Run id goes onto the raw response as
      // well as Fastify's header collection. Otherwise it is lost at the wire.
      const withRunHeader = <T>(runId: string | undefined, result: T): T => {
        if (runId) {
          reply.header("X-Run-Id", runId);
          reply.raw.setHeader("X-Run-Id", runId);
        }
        return result;
      };
      const submitter: ChatTurnSubmitter = {
        findSubmitted: async () => {
          const replayed = await durable.findSubmitted?.();
          return withRunHeader(replayed?.runId, replayed ?? null);
        },
        submit: async (request) => {
          const submission = await durable.submit(request);
          return withRunHeader(
            submission.outcome === "duplicate" ? submission.runId : submission.run?.runId,
            submission
          );
        },
      };
      return runChatTurn(req, reply, turnCtx, submitter);
    }
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
    {
      repo,
      messageRepo,
      workingMemory,
      knowledge,
      soulLoader,
      toolRegistry,
      bundledSkills,
      disabledBundledSkills,
    },
    requireAuth
  );
}
