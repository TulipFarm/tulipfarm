import type { EventEmitter } from "node:events";
import type { LlmService } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { ConversationStore } from "../conversations/service";
import {
  type RunEventStreamDeps,
  type RunStreamGrant,
  sinkFor,
  streamRunEvents,
} from "../runs/events";
import type { DurableInvocationGateway } from "../runtime/invocation-gateway";
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
}

/**
 * The Chat turn over HTTP: submit durably, then read back the Run's own event stream.
 *
 * Nothing about the turn happens in this process any more. The route opens the conversation, hands
 * the request to the submission path every channel shares, and then becomes a reader of
 * `run_events` — the same rows, in the same vocabulary, that `GET /api/v1/runs/:id/events` serves on
 * reconnect and that a Slack or Telegram reader would consume. Losing this connection therefore
 * loses nothing: the Worker is executing the Run regardless, and the client reattaches by cursor.
 */
export function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRoutesOptions,
  requireAuth: PreHandler
): void {
  const { stream } = options;

  app.post(
    "/api/v1/chat",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Submit one chat turn and stream the Run that answers it (SSE, Run event vocabulary — " +
          "the same frames as `GET /api/v1/runs/:id/events`). The Run id is returned in " +
          "`X-Run-Id`; reconnect against that Run with `?after=<sequence>`. An optional `model` " +
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
          403: ErrorSchema,
          404: ErrorSchema,
          409: DuplicateInvocationSchema,
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
      // A client that sends no key still gets idempotency, just only within its own retry of this
      // request — `req.id` is unique per delivery, so a second POST is a second Turn.
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
        // Scoped to the submitter. Turn keys are unique deployment-wide, and the value is whatever a
        // client chose to send, so an unscoped key lets one caller claim another's: their turn would
        // be refused as a duplicate and answered with a Run id that is not theirs.
        idempotencyKey: `${principal.kind}:${principal.id}:${clientKey}`,
        log: req.log,
      });

      // Asked before the conversation is opened: a retried first message must not leave an empty
      // conversation (and a generated title) behind for a turn that was already answered.
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
        // Already submitted and already answered by a Run. Streaming a second reply would answer one
        // message twice; the client reattaches to the Run it is given here.
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

      // The reply is hijacked below, so every header a client needs goes onto the raw response too —
      // Fastify's collection is not written once the socket is taken over.
      reply.header("X-Run-Id", runId);
      writeSseHeaders(reply.raw, {
        "X-Run-Id": runId,
        "X-Conversation-Id": entry.conversation._id,
        // Only a user-selected Soul Agent is exposed to the client: normal chat has no Agent
        // identity, and a removed Agent resolves back to normal chat.
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
      preHandler: requireAuth,
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
          503: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      if (!options.cancel) {
        return reply.code(503).send({ error: "run cancellation is not available" });
      }
      // The same grant that lets this caller read the Run is what lets them stop it: both are
      // "is this your turn?", and answering them differently would let one reader halt another's.
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
