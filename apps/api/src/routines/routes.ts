import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { writeSseHeaders } from "../chat/sse";
import { attachToStream } from "../chat/stream-attach";
import type { StreamHub } from "../chat/stream-hub";
import { corsPassthrough, parseLastEventId } from "../chat/turn-helpers";
import { definitionHash } from "./definition-hash";
import type { RoutineEnqueuers } from "./jobs";
import type { RoutineRegistry } from "./registry";
import type { RoutineRunsRepo } from "./run-store-adapter";
import { RunJournalStreamRepo, runStreamId } from "./stream-adapter";
import { RoutineTriggerError, type RoutineTriggerService } from "./trigger-service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const WEBHOOK_SECRET_HEADER = "x-tulipfarm-webhook-secret";

export interface RoutineRoutesDeps {
  registry: RoutineRegistry;
  runs: RoutineRunsRepo;
  triggerService: RoutineTriggerService;
  enqueuers: RoutineEnqueuers;
  /** Resolves a webhook trigger's secret_ref. */
  getSecret: (key: string) => Promise<string>;
  /** Live fan-out for run SSE (the driver publishes into the same hub). */
  hub?: StreamHub;
}

const RUN_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "routineSlug", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    routineSlug: { type: "string" },
    status: { type: "string" },
    currentState: { type: "string", nullable: true },
    trigger: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { type: "string", enum: ["event", "manual", "cron", "webhook", "agent"] },
        payload: {},
        triggerIndex: { type: "integer", minimum: 0 },
      },
    },
    output: {},
    error: {},
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    finishedAt: { type: "string", nullable: true },
  },
} as const;

const ROUTINE_DETAIL_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["slug", "valid", "definition", "hash", "hasHooks"],
      properties: {
        slug: { type: "string" },
        valid: { const: true },
        definition: {},
        hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        hasHooks: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["slug", "valid", "loadError"],
      properties: {
        slug: { type: "string" },
        valid: { const: false },
        loadError: { type: "string" },
      },
    },
  ],
} as const;

const TRIGGER_ERROR_STATUS = {
  not_found: 404,
  invalid_inputs: 400,
  trigger_not_declared: 422,
  routine_invalid: 422,
} as const;

function triggerErrorReply(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (!(err instanceof RoutineTriggerError)) return null;
  return reply.code(TRIGGER_ERROR_STATUS[err.code]).send({ error: err.message });
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Routine API (v0.11): listing, run history/detail, manual trigger, cancel, and the V1
 * webhook seam. The webhook route is deliberately outside session auth + CSRF (external
 * callers; CSRF only fires with a session cookie anyway) and is gated by a
 * constant-time shared-secret header check against the trigger's `secret_ref` (D6).
 */
export function registerRoutineRoutes(
  app: FastifyInstance,
  deps: RoutineRoutesDeps,
  requireAuth: PreHandler
): void {
  const { registry, runs, triggerService } = deps;

  app.get(
    "/api/v1/routines",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List all routines from the soul: valid ones with their triggers and manual-input " +
          "schema, invalid ones with their validation error (they never crash boot).",
        tags: ["routines"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["slug", "valid"],
                  properties: {
                    slug: { type: "string" },
                    valid: { type: "boolean" },
                    name: { type: "string", nullable: true },
                    description: { type: "string", nullable: true },
                    triggers: { type: "array", items: {} },
                    inputs: {},
                    hasHooks: { type: "boolean" },
                    loadError: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const items = registry.list().map((entry) =>
        entry.ok
          ? {
              slug: entry.slug,
              valid: true,
              name: entry.definition.name ?? entry.definition.id,
              description: entry.definition.description ?? null,
              triggers: entry.definition["x-triggers"],
              inputs: entry.definition["x-inputs"] ?? null,
              hasHooks: Boolean(entry.hookSource),
              loadError: null,
            }
          : { slug: entry.slug, valid: false, loadError: entry.loadError }
      );
      return reply.send({ items });
    }
  );

  app.get(
    "/api/v1/routines/:slug",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Full Routine detail for read-only visualization. Valid Routines include their live " +
          "definition and canonical hash; invalid Routines include only validation diagnostics.",
        tags: ["routines"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string", minLength: 1 } },
        },
        response: {
          200: ROUTINE_DETAIL_SCHEMA,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const entry = registry.getEntry(slug);
      if (!entry) return reply.code(404).send({ error: "routine not found" });
      if (!entry.ok) {
        return reply.send({ slug: entry.slug, valid: false, loadError: entry.loadError });
      }
      return reply.send({
        slug: entry.slug,
        valid: true,
        definition: entry.definition,
        hash: definitionHash(entry.definition),
        hasHooks: Boolean(entry.hookSource),
      });
    }
  );

  app.get(
    "/api/v1/routines/:slug/runs",
    {
      preHandler: requireAuth,
      schema: {
        description: "Run history for a routine, newest first.",
        tags: ["routines"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: { items: { type: "array", items: RUN_SUMMARY_SCHEMA } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const { limit } = req.query as { limit?: number };
      if (!registry.getEntry(slug)) return reply.code(404).send({ error: "routine not found" });
      const items = (await runs.listBySlug(slug, limit ?? 50)).map(toRunSummary);
      return reply.send({ items });
    }
  );

  app.get(
    "/api/v1/routines/:slug/runs/:runId",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Run detail: current status, pinned definition hash, data context, and the full " +
          "journal (durable event history — also the SSE replay source).",
        tags: ["routines"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug", "runId"],
          properties: {
            slug: { type: "string", minLength: 1 },
            runId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["run", "events"],
            properties: {
              run: {
                ...RUN_SUMMARY_SCHEMA,
                required: [
                  ...RUN_SUMMARY_SCHEMA.required,
                  "trigger",
                  "context",
                  "definitionHash",
                  "definitionSnapshot",
                  "attemptCounts",
                  "approvalId",
                ],
                properties: {
                  ...RUN_SUMMARY_SCHEMA.properties,
                  context: {},
                  definitionHash: { type: "string" },
                  definitionSnapshot: {},
                  attemptCounts: {},
                  approvalId: { type: "string", nullable: true },
                },
              },
              events: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["seq", "type"],
                  properties: {
                    seq: { type: "integer" },
                    type: { type: "string" },
                    payload: {},
                    createdAt: { type: "string" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug, runId } = req.params as { slug: string; runId: string };
      const run = await runs.findById(runId);
      if (!run || run.routineSlug !== slug) {
        return reply.code(404).send({ error: "run not found" });
      }
      const events = await runs.listEvents(runId);
      return reply.send({
        run: {
          ...toRunSummary(run),
          context: run.context,
          definitionHash: run.definitionHash,
          definitionSnapshot: run.definitionSnapshot,
          attemptCounts: run.attemptCounts,
          approvalId: run.approvalId,
        },
        events: events.map((e) => ({
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          createdAt: e.createdAt.toISOString(),
        })),
      });
    }
  );

  app.post(
    "/api/v1/routines/:slug/runs",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Manually trigger a routine. The body is validated against the routine's x-inputs " +
          "JSON Schema (the same gate webhook and agent triggers pass through).",
        tags: ["routines"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { inputs: { type: "object" } },
        },
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: ["runId"],
            properties: { runId: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const { inputs } = (req.body ?? {}) as { inputs?: Record<string, unknown> };
      try {
        const { runId } = await triggerService.trigger(slug, {
          type: "manual",
          payload: inputs ?? {},
        });
        return reply.code(202).send({ runId });
      } catch (err) {
        const handled = triggerErrorReply(reply, err);
        if (handled) return handled;
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/routines/:slug/runs/:runId/cancel",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Cancel a run. Pending/sleeping/waiting runs cancel immediately; a running run is " +
          "cancelled at its next state boundary (the driver's CAS transition misses).",
        tags: ["routines"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug", "runId"],
          properties: {
            slug: { type: "string", minLength: 1 },
            runId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: { status: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug, runId } = req.params as { slug: string; runId: string };
      const run = await runs.findById(runId);
      if (!run || run.routineSlug !== slug) {
        return reply.code(404).send({ error: "run not found" });
      }
      if (["succeeded", "failed", "cancelled"].includes(run.status)) {
        return reply.code(409).send({ error: `run already ${run.status}` });
      }
      const ok = await runs.transition(
        runId,
        { status: run.status },
        { status: "cancelled", wakeAt: null, stateDeadline: null, finished: true }
      );
      if (!ok) return reply.code(409).send({ error: "run state changed; retry" });
      return reply.send({ status: "cancelled" });
    }
  );

  if (deps.hub) {
    const hub = deps.hub;
    const journalRepo = new RunJournalStreamRepo(runs);
    app.get(
      "/api/v1/routines/:slug/runs/:runId/events",
      {
        preHandler: requireAuth,
        schema: {
          description:
            "Live SSE stream of a run's events (state transitions, outputs). Replays from the " +
            "durable journal via `Last-Event-ID` (or ?lastEventId=) — works for runs of any age. " +
            "Each selected route is emitted as `state.transitioned`, including ordered " +
            'condition/error identity. Suspended runs close with `{reason: "suspended"}`.',
          tags: ["routines"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          params: {
            type: "object",
            required: ["slug", "runId"],
            properties: {
              slug: { type: "string", minLength: 1 },
              runId: { type: "string", minLength: 1 },
            },
          },
          querystring: {
            type: "object",
            properties: { lastEventId: { type: "integer", minimum: 0 } },
          },
          response: {
            200: {
              type: "string",
              description:
                "Server-sent Run journal events, including state.transitioned route identity.",
            },
            401: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const { slug, runId } = req.params as { slug: string; runId: string };
        const run = await runs.findById(runId);
        if (!run || run.routineSlug !== slug) {
          return reply.code(404).send({ error: "run not found" });
        }
        const afterSeq = parseLastEventId(
          req.headers["last-event-id"],
          (req.query as { lastEventId?: number }).lastEventId
        );
        writeSseHeaders(reply.raw, corsPassthrough(reply));
        reply.hijack();
        await attachToStream(reply.raw, runStreamId(runId), afterSeq, {
          repo: journalRepo,
          hub,
        });
      }
    );
  }

  // ── Webhook seam (D6) — NO session auth, NO CSRF (no session cookie involved) ──
  app.post(
    "/api/v1/hooks/routines/:slug",
    {
      schema: {
        description:
          "Inbound webhook trigger for a routine (V1 seam; full integration ingress is v0.12). " +
          `Auth: constant-time match of the "${WEBHOOK_SECRET_HEADER}" header against the ` +
          "routine's webhook trigger secret_ref. Rejects when no secret is configured — never open.",
        tags: ["routines"],
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string", minLength: 1 } },
        },
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: ["runId"],
            properties: { runId: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const routine = registry.get(slug);
      const webhookTriggerIndex =
        routine?.definition["x-triggers"].findIndex((trigger) => trigger.type === "webhook") ?? -1;
      const webhookTrigger = routine?.definition["x-triggers"][webhookTriggerIndex];
      if (!routine || !webhookTrigger || webhookTrigger.type !== "webhook") {
        return reply.code(404).send({ error: "routine or webhook trigger not found" });
      }

      let secret: string;
      try {
        secret = await deps.getSecret(webhookTrigger.secret_ref);
      } catch {
        return reply.code(401).send({ error: "webhook secret not configured" });
      }
      const presented = req.headers[WEBHOOK_SECRET_HEADER];
      const presentedValue = Array.isArray(presented) ? presented[0] : presented;
      if (!presentedValue || !constantTimeEquals(presentedValue, secret)) {
        return reply.code(401).send({ error: "invalid webhook secret" });
      }

      try {
        const { runId } = await triggerService.trigger(slug, {
          type: "webhook",
          payload: req.body ?? {},
          triggerIndex: webhookTriggerIndex,
        });
        return reply.code(202).send({ runId });
      } catch (err) {
        const handled = triggerErrorReply(reply, err);
        if (handled) return handled;
        throw err;
      }
    }
  );
}

function toRunSummary(run: {
  id: string;
  routineSlug: string;
  status: string;
  currentState: string | null;
  trigger: unknown;
  output: unknown;
  error: unknown;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: run.id,
    routineSlug: run.routineSlug,
    status: run.status,
    currentState: run.currentState,
    trigger: run.trigger,
    output: run.output,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}
