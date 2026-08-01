import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { formatSseEvent, writeSseHeaders } from "../chat/sse";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";

/** Who a persisted Run event may be shown to (mirrors `@tulipfarm/storage`'s `RunEventAudience`). */
export type RunEventAudience = "participant" | "operator";

export interface RunEventRecord {
  readonly sequence: number;
  readonly eventType: string;
  readonly audience: RunEventAudience;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
}

/** Read-only surface of the persisted Run event stream. The stream never writes Run state. */
export interface RunEventReader {
  list(
    businessId: string,
    runId: string,
    options: { after: number; audiences: readonly RunEventAudience[]; limit?: number }
  ): Promise<readonly RunEventRecord[]>;
}

export interface RunStatusReader {
  find(businessId: string, runId: string): Promise<{ status: string } | null>;
}

/** Reader's access to one Run, re-checked on every poll so a revoked grant closes the stream. */
export interface RunStreamGrant {
  readonly businessId: string;
  readonly audiences: readonly RunEventAudience[];
}

/** Minimal writable surface an SSE stream needs; a Node `ServerResponse` satisfies it. */
export interface SseSink {
  readonly destroyed: boolean;
  write(chunk: string): boolean;
  waitForDrain(): Promise<void>;
  end(): void;
}

export type RunStreamOutcome =
  | "completed"
  | "client_disconnected"
  | "authorization_revoked"
  | "run_not_found";

export interface RunEventStreamDeps {
  readonly events: RunEventReader;
  readonly runs: RunStatusReader;
  /** Re-evaluated each poll; `null` means the reader may no longer see this Run. */
  readonly authorize: () => Promise<RunStreamGrant | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly pageSize?: number;
}

export interface RunEventStreamRequest {
  readonly runId: string;
  readonly after: number;
}

const TERMINAL_RUN_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled"];
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_PAGE_SIZE = 200;

/**
 * Streams a Run's persisted events over SSE (SPEC §18). Delivery starts strictly after the
 * client's cursor, so a reconnect replays in order with no duplicates; the stream is a pure reader,
 * so losing it — or never reading it — cannot change the Run. Authorization is re-checked every
 * poll, a slow consumer is respected through backpressure, and the stream ends once the Run is
 * terminal and its backlog is fully delivered.
 */
export async function streamRunEvents(
  sink: SseSink,
  deps: RunEventStreamDeps,
  request: RunEventStreamRequest
): Promise<RunStreamOutcome> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  let cursor = request.after;

  for (;;) {
    if (sink.destroyed) return "client_disconnected";

    const grant = await deps.authorize();
    if (!grant) {
      await emit(sink, { seq: cursor, eventType: "stream.revoked", data: { reason: "revoked" } });
      sink.end();
      return "authorization_revoked";
    }

    const page = await deps.events.list(grant.businessId, request.runId, {
      after: cursor,
      audiences: grant.audiences,
      limit: pageSize,
    });
    for (const event of page) {
      if (sink.destroyed) return "client_disconnected";
      cursor = event.sequence;
      await emit(sink, {
        seq: event.sequence,
        eventType: event.eventType,
        data: { ...event.payload, occurredAt: event.occurredAt },
      });
    }
    // A full page means more backlog is waiting; drain it before polling for Run status.
    if (page.length === pageSize) continue;

    const run = await deps.runs.find(grant.businessId, request.runId);
    if (!run) {
      sink.end();
      return "run_not_found";
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      await emit(sink, {
        seq: cursor,
        eventType: "stream.closed",
        data: { status: run.status },
      });
      sink.end();
      return "completed";
    }
    await deps.sleep(deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}

async function emit(
  sink: SseSink,
  event: { seq: number; eventType: string; data: unknown }
): Promise<void> {
  if (!sink.write(formatSseEvent(event))) await sink.waitForDrain();
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface RunEventRouteDeps {
  readonly events: RunEventReader;
  readonly runs: RunStatusReader;
  /** Resolves the caller's grant for a Run; `null` denies the stream. */
  readonly authorize: (req: FastifyRequest, runId: string) => Promise<RunStreamGrant | null>;
  readonly pollIntervalMs?: number;
  readonly pageSize?: number;
}

/** Parses the reconnect cursor: an explicit `?after=` wins, else the SSE `Last-Event-ID` header. */
export function parseAfterCursor(
  header: string | string[] | undefined,
  query: number | undefined
): number {
  if (typeof query === "number" && Number.isSafeInteger(query) && query >= 0) return query;
  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Adapts a hijacked Fastify reply to the sink `streamRunEvents` writes through. */
export function sinkFor(reply: FastifyReply): SseSink {
  const raw = reply.raw;
  return {
    get destroyed() {
      return raw.destroyed;
    },
    write: (chunk) => raw.write(chunk),
    waitForDrain: () =>
      new Promise((resolve) => {
        raw.once("drain", resolve);
      }),
    end: () => raw.end(),
  };
}

/** Each stream holds a connection open, so cap how fast one client may (re)open them. */
const STREAM_LIMIT = 30;
const STREAM_WINDOW_MS = 60_000;

/** `GET /api/v1/runs/:id/events` — persisted Run event stream with cursor recovery (SPEC §18). */
export function registerRunEventRoutes(
  app: FastifyInstance,
  deps: RunEventRouteDeps,
  requireAuth: PreHandler,
  rateLimiter?: RateLimiter
): void {
  const rateLimitHook = rateLimiter
    ? makeRateLimitHook(
        rateLimiter,
        (req) => `rl:run-events:${req.ip}`,
        STREAM_LIMIT,
        STREAM_WINDOW_MS
      )
    : undefined;

  app.get(
    "/api/v1/runs/:id/events",
    {
      preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : [requireAuth],
      schema: {
        description:
          "SSE stream of a Run's persisted events. Delivery resumes strictly after the cursor — " +
          "`?after=<sequence>` or the `Last-Event-ID` header — so a reconnect is ordered and free " +
          "of duplicates. The stream is read-only: losing it never changes the Run. Events the " +
          "caller's audience does not cover are withheld, and the stream closes if that grant is " +
          "revoked.",
        tags: ["runs"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: { type: "integer", minimum: 0 } },
        },
        response: {
          200: {
            type: "string",
            description: "Server-sent Run events; `id:` carries the resume cursor.",
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const grant = await deps.authorize(req, id);
      if (!grant) return reply.code(403).send({ error: "run stream not authorized" });

      const run = await deps.runs.find(grant.businessId, id);
      if (!run) return reply.code(404).send({ error: "run not found" });

      const after = parseAfterCursor(
        req.headers["last-event-id"],
        (req.query as { after?: number }).after
      );
      writeSseHeaders(reply.raw);
      reply.hijack();
      await streamRunEvents(
        sinkFor(reply),
        {
          events: deps.events,
          runs: deps.runs,
          authorize: () => deps.authorize(req, id),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          pollIntervalMs: deps.pollIntervalMs,
          pageSize: deps.pageSize,
        },
        { runId: id, after }
      );
    }
  );
}
