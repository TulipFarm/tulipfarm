import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { LlmNotConfiguredError, type LlmService, UnknownModelError } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import { type CoreMessage, streamText } from "ai";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { assembleSystemPrompt } from "../context/assemble";
import { DOMAIN_EVENTS } from "../domain-events";
import type { KnowledgeService } from "../knowledge/service";
import { MAX_TOOL_STEPS } from "../memory/limits";
import type { WorkingMemoryService } from "../memory/service";
import { parsePaginationQuery } from "../pagination";
import { resolveAgent } from "../soul/agents/registry";
import { BatchCoordinator } from "../tools/batch-executor";
import type { ToolRegistry } from "../tools/registry";
import type { ToolCallResult } from "../tools/types";
import { ApprovalRegistry, makeApprovalGate } from "./approvals";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import {
  type MessagePart,
  type MessageRepo,
  fromAssistantParts,
  fromAssistantText,
  fromToolResult,
  fromUserText,
  toCoreMessage,
} from "./messages";
import { attachToStream, runChatStream } from "./producer";
import { MessageSchema } from "./schemas";
import { writeSseHeaders } from "./sse";
import { makeStreamEmitter } from "./stream-emitter";
import type { StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";

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

/**
 * Resolve the resume cursor: the `Last-Event-ID` header (set automatically by an
 * `EventSource` on reconnect) takes precedence over the `?lastEventId=` query. A
 * missing/invalid value means "from the start" (seq 0).
 */
export function parseLastEventId(
  header: string | string[] | undefined,
  query: number | undefined
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return typeof query === "number" && query >= 0 ? query : 0;
}

/** The subset of an AI SDK `StepResult` that persistence needs. */
interface PersistableStep {
  text: string;
  finishReason: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; args: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; toolName: string; result: unknown }>;
}

/**
 * Persist one finished `streamText` step. A tool step yields an assistant message holding the
 * tool-call parts (plus any text) followed by a tool message holding the results; a final text step
 * yields a plain assistant message. Errored or empty steps persist nothing. Exported for tests.
 */
export async function persistStep(
  messageRepo: MessageRepo,
  conversationId: string,
  step: PersistableStep,
  onError: (err: unknown) => void
): Promise<void> {
  if (step.finishReason === "error") return;

  if (step.toolCalls.length > 0) {
    const parts: MessagePart[] = [];
    if (step.text) parts.push({ type: "text", text: step.text });
    for (const tc of step.toolCalls) {
      parts.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      });
    }
    await messageRepo.create(fromAssistantParts(conversationId, parts)).catch(onError);

    if (step.toolResults.length > 0) {
      const resultParts: MessagePart[] = step.toolResults.map((tr) => ({
        type: "tool-result",
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        result: tr.result,
      }));
      await messageRepo.create(fromToolResult(conversationId, resultParts)).catch(onError);
    }
    return;
  }

  if (step.text) {
    await messageRepo.create(fromAssistantText(conversationId, step.text)).catch(onError);
  }
}

// @fastify/cors adds CORS headers on the normal reply path, but `reply.hijack()` (used for the SSE
// stream) bypasses it — so a cross-origin browser `fetch` is blocked and X-Conversation-Id is unreadable.
// Copy the headers the cors hook already set onto the raw response.
function corsPassthrough(reply: FastifyReply): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-expose-headers",
    "vary",
  ]) {
    const value = reply.getHeader(name);
    if (typeof value === "string") out[name] = value;
    else if (typeof value === "number") out[name] = String(value);
    else if (Array.isArray(value)) out[name] = value.join(", ");
  }
  return out;
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
  approvals?: ApprovalRegistry
): void {
  // One in-process approval registry shared by the chat turn (which suspends gated tools) and the
  // decide route (which resolves them). Single-instance V1 — see chat/approvals.ts.
  const approvalRegistry = approvals ?? new ApprovalRegistry();

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

      // 4. Build history + persist the user turn (survives an aborted stream). The full system
      //    prompt is reconstructed every turn from durable stores in a fixed block order
      //    (CONTEXT-ENGINE §1), so the cacheable prefix is byte-stable across turns (AC-V1-001).
      const history = await messageRepo.listByConversation(convo._id, 1000);
      const messages: CoreMessage[] = [];
      const agent = resolveAgent(soulLoader, convo.agentId);
      const agentDomain =
        typeof agent.frontmatter.domain === "string" ? agent.frontmatter.domain : null;
      const system = assembleSystemPrompt({
        agentId: agent.name,
        domain: agentDomain,
        tenantId: "default",
        personality: agent.body,
        memory: workingMemory ? await workingMemory.list(user._id) : [],
        governanceDocs: knowledge ? await knowledge.governanceDocuments() : [],
      });
      if (system) messages.push({ role: "system", content: system });
      messages.push(...history.items.map(toCoreMessage), {
        role: "user",
        content: body.message.content,
      });
      await messageRepo.create(fromUserText(convo._id, body.message.content));
      await repo.touch(convo._id);

      // 5. Stream the assistant reply over SSE. Each event carries an `id` so a dropped
      //    connection can reconnect via Last-Event-ID; the producer runs detached so the
      //    turn finishes (and keeps buffering) even after the client disconnects.
      const streamId = randomUUID();
      if (isNew) reply.raw.setHeader("X-Conversation-Id", convo._id);
      writeSseHeaders(reply.raw, { "X-Stream-Id": streamId, ...corsPassthrough(reply) });
      reply.hijack();
      hub.register(streamId);
      // Shared per-turn emitter: the producer loop AND the approval gate emit through it, so
      // out-of-band approval events stay on one monotonic, serialized seq (see stream-emitter.ts).
      const emitter = makeStreamEmitter(streamId, { repo: streamRepo, hub, log: req.log });

      const coordinator = new BatchCoordinator();
      const fullResultCache = new Map<string, ToolCallResult>();
      const tools =
        toolRegistry && toolRegistry.getAll().length > 0
          ? toolRegistry.buildToolSet(
              { userId: user._id, agentId: agent.name, autonomy: body.autonomy },
              coordinator,
              fullResultCache,
              makeApprovalGate(approvalRegistry, emitter)
            )
          : undefined;

      const result = streamText({
        model: selected,
        messages,
        tools,
        maxSteps: MAX_TOOL_STEPS,
        onError: ({ error }) => {
          req.log.error({ err: error, conversationId: convo._id }, "chat stream error");
        },
        // A completed turn feeds the knowledge AgentConversationSource (AC-V1-002).
        onFinish: () => {
          events?.emit(DOMAIN_EVENTS.CONVERSATION_COMPLETED, { conversationId: convo._id });
        },
        // Persist each finished step (text and/or tool-call + tool-result) so the durable history
        // captures the whole tool loop, not just the final assistant text.
        onStepFinish: (step) =>
          persistStep(messageRepo, convo._id, step as unknown as PersistableStep, (e) =>
            req.log.error({ err: e, conversationId: convo._id }, "persist failed")
          ),
      });

      // Attach this connection (live from seq 0) and start the detached producer.
      void attachToStream(reply.raw, streamId, 0, { repo: streamRepo, hub });
      void runChatStream(streamId, result.fullStream, {
        emitter,
        hub,
        log: req.log,
        fullResultCache,
      });
    }
  );

  app.post(
    "/api/v1/chat/approvals/:approvalId/decide",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Approve or deny a pending tool-execution approval. Resumes the suspended chat stream " +
          "with the tool result (approve) or an error result the model sees (deny).",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["approvalId"],
          properties: { approvalId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["decision"],
          additionalProperties: false,
          properties: { decision: { type: "string", enum: ["approve", "deny"] } },
        },
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      const { decision } = req.body as { decision: "approve" | "deny" };
      const resolved = approvalRegistry.decide(
        approvalId,
        decision === "approve" ? "approved" : "denied"
      );
      if (!resolved) {
        return reply.code(404).send({ error: "approval not found or already resolved" });
      }
      return reply.send({ status: decision });
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
