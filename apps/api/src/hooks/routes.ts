import { ingestWebhook, type WebhookIngressDeps, type WebhookTrigger } from "@tulipfarm/run-kernel";
import type { FastifyInstance } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";

export interface HookIngressDeps {
  /** Resolve the published webhook Trigger bound to this provider + slug, or `null`. */
  resolveTrigger(provider: string, triggerSlug: string): Promise<WebhookTrigger | null>;
  ingress: WebhookIngressDeps;
  /** Receipt clock, injectable so ingress stays deterministic under test. */
  now?: () => string;
  rateLimiter?: RateLimiter;
}

/** Constant 404 body: never reveal whether a Trigger exists, is published, or is signed. */
const NOT_FOUND = { error: "hook not found" };

/**
 * The receiver is public, so the limit is per sender and per Trigger rather than global, and it
 * is set well above a normal provider's delivery rate — a legitimate burst or redelivery storm
 * must not be dropped, while an unauthenticated flood still cannot run signature verification
 * without bound.
 */
const HOOK_LIMIT = 600;
const HOOK_WINDOW_MS = 60_000;

/**
 * Canonical signed-webhook receiver. No session auth and no CSRF — the route authenticates the
 * provider by the Trigger's declared signature scheme and nothing else. It registers in its own
 * plugin scope so the raw request bytes survive for verification, and it returns `202` only once
 * `ingestWebhook` has persisted the canonical event.
 */
export async function registerHookIngressRoutes(
  app: FastifyInstance,
  deps: HookIngressDeps
): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body)
    );

    const rateLimitHook = deps.rateLimiter
      ? makeRateLimitHook(
          deps.rateLimiter,
          (req) => {
            const { provider, trigger } = req.params as { provider: string; trigger: string };
            return `rl:hook:${req.ip}:${provider}:${trigger}`;
          },
          HOOK_LIMIT,
          HOOK_WINDOW_MS
        )
      : undefined;

    scope.post(
      "/api/v1/hooks/:provider/:trigger",
      {
        ...(rateLimitHook ? { preHandler: rateLimitHook } : {}),
        schema: {
          description:
            "Signed webhook receiver for a published Trigger. The delivery is signature-" +
            "verified, size-capped, filtered, and normalized into a canonical EventEnvelope; " +
            "202 is returned only after the event has been durably persisted.",
          tags: ["triggers"],
          params: {
            type: "object",
            required: ["provider", "trigger"],
            properties: {
              provider: { type: "string", minLength: 1 },
              trigger: { type: "string", minLength: 1 },
            },
          },
          response: {
            202: {
              type: "object",
              required: ["status"],
              properties: {
                status: { type: "string", enum: ["accepted", "duplicate", "ignored"] },
              },
            },
            400: ErrorSchema,
            401: ErrorSchema,
            404: ErrorSchema,
            413: ErrorSchema,
            429: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const { provider, trigger: triggerSlug } = req.params as {
          provider: string;
          trigger: string;
        };
        const trigger = await deps.resolveTrigger(provider, triggerSlug);
        if (!trigger) return reply.code(404).send(NOT_FOUND);

        const result = await ingestWebhook(
          trigger,
          {
            rawBody: req.body as Buffer,
            headers: req.headers,
            receivedAt: (deps.now ?? (() => new Date().toISOString()))(),
          },
          deps.ingress
        );

        if (result.status !== 202) {
          req.log.warn({ provider, trigger: triggerSlug, code: result.code }, "hook rejected");
          return reply.code(result.status).send({ error: result.code });
        }
        return reply.code(202).send({ status: result.outcome });
      }
    );
  });
}
