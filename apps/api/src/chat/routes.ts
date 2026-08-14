import type { EventEmitter } from "node:events";
import type { LlmService } from "@tulipfarm/llm";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { ConversationStore } from "../conversations/service";
import { MemoryRateLimiter, makeRateLimitHook, type RateLimiter } from "../rate-limit";
import {
  type RunEventStreamDeps,
  type RunStreamGrant,
  sinkFor,
  streamRunEvents,
} from "../runs/events";
import { DEFAULT_ASSISTANT_NAME } from "../soul/agents/registry";
import { isConversationEntryError, resolveConversationEntry } from "./conversation-entry";
import type { ConversationRepo } from "./conversations";
import { writeSseHeaders } from "./sse";
import { type ChatBody, ChatBodySchema, corsPassthrough } from "./turn-helpers";
import { durableTurnSubmitter } from "./turn-submit";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 409 body for a replayed request: the Run that already answers it, so the client can reattach. */
const DuplicateInvocationSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" }, runId: { type: "string" } },
} as const;

/** Stops a Run a participant abandoned. `false` when the Run is gone or already terminal. */
export interface ChatRunCanceller {
  cancel(input: { businessId: string; runId: string; reason: string }): Promise<boolean>;
}

/** Reads the Run this turn produced. The same reader `GET /runs/:id/events` reconnects against. */
export interface ChatStreamDeps
  extends Pick<RunEventStreamDeps, "events" | "runs" | "pollIntervalMs" | "pageSize"> {
  /** Re-evaluated on every poll, so a revoked grant closes the stream mid-turn. */
  authorize(req: FastifyRequest, runId: string): Promise<RunStreamGrant | null>;
}

export interface ChatRoutesOptions {
  readonly llmService: LlmService;
  readonly repo: ConversationRepo;
  readonly conversationStore: ConversationStore;
  readonly invocations: DurableInvocationGateway;
  readonly stream: ChatStreamDeps;
  readonly cancel?: ChatRunCanceller;
  readonly soulLoader?: SoulLoader;
  readonly events?: EventEmitter;
  /** Shared limiter; absent falls back to an in-process one, so a turn is never unbudgeted. */
  readonly rateLimiter?: RateLimiter;
}

/** Per-principal turn budget; IP keys would let one proxied caller exhaust everyone. */
const CHAT_LIMIT = 60;
const CHAT_WINDOW_MS = 60_000;

/** HTTP chat turn: durably submit, then read the Run event stream; clients reattach by cursor. */
export function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRoutesOptions,
  requireAuth: PreHandler
): void {
  const { stream } = options;
  // Authenticated requests key the budget by principal; `req.ip` only covers rejected requests.
  const rateLimitHook = makeRateLimitHook(
    options.rateLimiter ?? new MemoryRateLimiter(),
    (req) => `rl:chat:${req.principal?.id ?? req.ip}`,
    CHAT_LIMIT,
    CHAT_WINDOW_MS
  );

  app.post(
    "/api/v1/chat",
    {
      preHandler: [requireAuth, rateLimitHook],
      schema: {
        description:
          "Submit one chat turn and stream the Run that answers it (SSE, Run event vocabulary — " +
          "the same frames as `GET /api/v1/runs/:id/events`). The Run id is returned in " +
          "`X-Run-Id`; reconnect against that Run with `?after=<sequence>`. An optional `model` " +
          "(tier name or model id) overrides the model for this turn only; it is never persisted.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        // Bounded because the Turn stores this client value verbatim.
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: ChatBodySchema,
        response: {
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: DuplicateInvocationSchema,
          429: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      const user = req.user as { _id: string } | undefined;
      if (!(principal && user)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const body = req.body as ChatBody;
      const idempotencyHeader = req.headers["idempotency-key"];
      // Without a client key, idempotency is only within this delivered request.
      const clientKey =
        typeof idempotencyHeader === "string" && idempotencyHeader.length > 0
          ? idempotencyHeader
          : req.id;
      const submitter = durableTurnSubmitter({
        store: options.conversationStore,
        invocations: options.invocations,
        principal: { kind: principal.kind, id: principal.id, businessId: principal.businessId },
        payload: body,
        agentId: body.agentId ?? "assistant",
        // Scope the client key to the submitter; unscoped keys let callers claim each other's Runs.
        idempotencyKey: `${principal.kind}:${principal.id}:${clientKey}`,
        log: req.log,
      });

      // Check replay before opening a Conversation so retries do not leave empty shells.
      const replayed = await submitter.findSubmitted?.();
      if (replayed) {
        return reply.code(409).send({ error: "duplicate chat invocation", runId: replayed.runId });
      }

      const entry = await resolveConversationEntry(
        {
          repo: options.repo,
          llmService: options.llmService,
          ...(options.soulLoader ? { soulLoader: options.soulLoader } : {}),
          ...(options.events ? { events: options.events } : {}),
        },
        { userId: user._id, body, log: req.log }
      );
      if (isConversationEntryError(entry)) {
        return reply.code(entry.status).send({ error: entry.error });
      }

      const submission = await submitter.submit({
        conversationId: entry.conversation._id,
        content: body.message.content,
      });
      if (submission.outcome === "duplicate") {
        // Replayed turn: return the existing Run so one message is not answered twice.
        return reply
          .code(409)
          .send({ error: "duplicate chat invocation", runId: submission.runId });
      }
      const runId = submission.run?.runId;
      if (!runId) {
        return reply.code(503).send({ error: "chat turn could not be dispatched" });
      }

      const grant = await stream.authorize(req, runId);
      if (!grant) return reply.code(403).send({ error: "run stream not authorized" });

      // Hijacking bypasses Fastify's header collection; write required headers to raw too.
      reply.header("X-Run-Id", runId);
      writeSseHeaders(reply.raw, {
        "X-Run-Id": runId,
        "X-Conversation-Id": entry.conversation._id,
        // Only user-selected Soul Agents are exposed; normal chat has no Agent identity.
        ...(entry.agentId === DEFAULT_ASSISTANT_NAME ? {} : { "X-Agent-Id": entry.agentId }),
        ...corsPassthrough(reply),
      });
      reply.hijack();
      await streamRunEvents(
        sinkFor(reply),
        {
          events: stream.events,
          runs: stream.runs,
          authorize: () => stream.authorize(req, runId),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          ...(stream.pollIntervalMs === undefined ? {} : { pollIntervalMs: stream.pollIntervalMs }),
          ...(stream.pageSize === undefined ? {} : { pageSize: stream.pageSize }),
        },
        { runId, after: 0 }
      );
    }
  );

  app.post(
    "/api/v1/chat/runs/:runId/stop",
    {
      preHandler: [requireAuth, rateLimitHook],
      schema: {
        description:
          "Stop the Run answering a chat turn. Cancellation is requested of the Run itself, so it " +
          "halts the turn in whichever process is executing it — the stream then ends with the " +
          "Run's terminal status. 404 if the Run is unknown or already finished.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string", minLength: 1 } },
        },
        response: {
          200: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      if (!options.cancel) {
        return reply.code(503).send({ error: "run cancellation is not available" });
      }
      // Stop uses the same grant as Run reads so one reader cannot halt another's Run.
      const grant = await stream.authorize(req, runId);
      if (!grant) return reply.code(403).send({ error: "run not yours to stop" });

      const stopped = await options.cancel.cancel({
        businessId: grant.businessId,
        runId,
        reason: "stopped by participant",
      });
      if (!stopped) return reply.code(404).send({ error: "run not found or already finished" });
      return reply.send({ status: "stopped" });
    }
  );
}
