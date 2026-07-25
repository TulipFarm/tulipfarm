import {
  buildInvocation,
  type RegisteredTrigger,
  type RunInvocation,
  TriggerBindError,
} from "@tulipfarm/run-kernel";
import { event as eventSchema } from "@tulipfarm/schema";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ErrorSchema } from "../auth/schemas";

export interface TriggerInvokeDeps {
  /** Resolve the Trigger by slug, or `null` when the caller may not know it exists. */
  resolveTrigger(slug: string): Promise<RegisteredTrigger | null>;
  sink: {
    accept(
      envelope: eventSchema.EventEnvelope<Record<string, unknown>>
    ): Promise<{ outcome: "accepted" | "duplicate" }>;
  };
  startRun(invocation: RunInvocation): Promise<{ runId: string; outcome: "started" | "duplicate" }>;
  nextEventId: () => string;
  now?: () => string;
}

/** Constant 404 body: never reveal whether a Trigger exists or is merely not invokable. */
const NOT_FOUND = { error: "trigger not found" };

/** Only these Trigger types accept a caller-initiated invocation. */
const INVOKABLE = new Set(["manual", "internal_api"]);

/**
 * Caller-initiated Trigger invocation for `manual` and `internal_api` Triggers.
 *
 * The caller supplies data and an idempotency key; it does not supply identity. The Run always
 * starts under the Trigger's authored background identity, its input is only what the Trigger
 * mapped, and the canonical event is persisted before the Run is started so a crash between the
 * two replays rather than losing the invocation.
 */
export function registerTriggerRoutes(
  app: FastifyInstance,
  deps: TriggerInvokeDeps,
  requireAuth: preHandlerHookHandler
): void {
  app.post(
    "/api/v1/triggers/:slug/invoke",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Invoke a manual or internal-API Trigger. The request is normalized into a canonical " +
          "EventEnvelope, persisted, and bound to the Trigger's Routine under the Trigger's own " +
          "background identity. Repeating an idempotency key returns the original Run.",
        tags: ["triggers"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            data: { type: "object", additionalProperties: true },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["runId", "status"],
            properties: {
              runId: { type: "string" },
              status: { type: "string", enum: ["started", "duplicate"] },
            },
          },
          401: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const body = (req.body ?? {}) as {
        data?: Record<string, unknown>;
        idempotencyKey?: string;
      };

      const trigger = await deps.resolveTrigger(slug);
      if (!trigger || trigger.lifecycle !== "published" || !INVOKABLE.has(trigger.type)) {
        return reply.code(404).send(NOT_FOUND);
      }

      const now = (deps.now ?? (() => new Date().toISOString()))();
      const eventId = deps.nextEventId();
      const envelope = eventSchema.validateEventEnvelope<Record<string, unknown>>({
        eventId,
        type: trigger.eventType,
        version: trigger.eventVersion,
        occurredAt: now,
        receivedAt: now,
        businessId: "default",
        source: { provider: "tulipfarm" },
        principal: { kind: "user", internalId: req.user?._id ?? "unknown" },
        record: {},
        deduplicationKey: `${slug}:${body.idempotencyKey ?? eventId}`,
        classification: [],
        data: body.data ?? {},
        verification: { status: "unverified" },
      });

      let invocation: RunInvocation;
      try {
        invocation = buildInvocation(trigger, envelope);
      } catch (error) {
        if (error instanceof TriggerBindError) {
          req.log.warn({ slug, code: error.code }, "trigger invocation rejected");
          return reply.code(422).send({ error: error.code });
        }
        throw error;
      }

      await deps.sink.accept(envelope);
      const { runId, outcome } = await deps.startRun(invocation);
      return reply.code(202).send({ runId, status: outcome });
    }
  );
}
