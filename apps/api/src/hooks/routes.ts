import {
  buildInvocation,
  ingestWebhook,
  passesTriggerContentGate,
  type RegisteredTrigger,
  type RunInvocation,
  TriggerBindError,
  type WebhookIngressDeps,
  type WebhookTrigger,
} from "@tulipfarm/run-kernel";
import type { FastifyInstance } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";

export interface HookIngressDeps {
  resolveTrigger(provider: string, triggerSlug: string): Promise<WebhookTrigger | null>;
  ingress: WebhookIngressDeps;
  /**
   * The same Trigger in the matcher's view. Separate from `resolveTrigger` because verification
   * and binding read disjoint halves of the authored spec.
   */
  resolveInvocationTrigger?(triggerSlug: string): Promise<RegisteredTrigger | null>;
  startRun?(
    invocation: RunInvocation
  ): Promise<{ runId: string; outcome: "started" | "duplicate" }>;
  now?: () => string;
  rateLimiter?: RateLimiter;
}

/** Constant 404 body: never reveal whether a Trigger exists, is published, or is signed. */
const NOT_FOUND = { error: "hook not found" };

/** Public receiver limit is per sender and Trigger: permit redeliveries, bound floods. */
const HOOK_LIMIT = 600;
const HOOK_WINDOW_MS = 60_000;

/**
 * Public webhook receiver: verify Trigger signatures on raw bytes and return 202 after persistence.
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

        // A duplicate is re-bound on purpose: `startRun` is idempotent on the event's deduplication
        // key, so redelivery is what heals a crash between persisting the event and minting its
        // Run. A failure here is left to propagate for the same reason — a 202 over a lost Run
        // would strand the delivery, and the sender's retry is the only thing that recovers it.
        if (result.envelope !== undefined && deps.resolveInvocationTrigger && deps.startRun) {
          const registered = await deps.resolveInvocationTrigger(triggerSlug);
          if (registered !== null) {
            // The URL already said which Trigger this is, so matching is not re-run — but the
            // author's `filter`/`match` still decide whether they wanted *this* event. Skipping
            // them would accept a filter at authoring time and then never consult it.
            if (!passesTriggerContentGate(registered, result.envelope)) {
              req.log.info(
                { provider, trigger: triggerSlug },
                "hook event did not pass the Trigger's filter"
              );
              return reply.code(202).send({ status: result.outcome });
            }
            try {
              const { runId } = await deps.startRun(buildInvocation(registered, result.envelope));
              req.log.info({ provider, trigger: triggerSlug, runId }, "hook started routine run");
            } catch (error) {
              if (!(error instanceof TriggerBindError)) throw error;
              req.log.warn(
                { provider, trigger: triggerSlug, code: error.code },
                "hook event did not bind to its Trigger"
              );
            }
          }
        }
        return reply.code(202).send({ status: result.outcome });
      }
    );
  });
}
