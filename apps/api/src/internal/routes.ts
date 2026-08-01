import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import {
  type DeliveryDenial,
  DeliveryDeniedError,
  type IngressDeliveryHost,
  type ReplyOutcome,
} from "./delivery-host";
import {
  type HostedToolCall,
  type InternalTurnHost,
  type TurnAuthorityDenial,
  TurnAuthorityError,
} from "./turn-host";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * `/api/v1/internal/*` — what the Worker calls back into (plan §3).
 *
 * These routes are not part of the product surface. They exist because the Worker executes turns
 * while the conversation history, the Soul artifacts, and the Tool catalog still live here, and an
 * application may not import another application. PR 4 moves the implementations into the Worker
 * and these routes go away; nothing outside this directory is built against them.
 *
 * Two gates, both non-negotiable. Only a **service** principal may call at all — a signed-in person
 * holding a session cookie is refused, so a browser cannot reach the turn machinery. And every
 * handler names only a Run: authority comes from the Run's recorded `effectiveSubject`, never from
 * the caller, so a stolen worker credential cannot act as anyone it likes.
 */

const DENIAL_STATUS: Readonly<Record<TurnAuthorityDenial, number>> = {
  run_not_found: 404,
  // The Run exists but no executor is entitled to write for it: a redelivery, or a worker whose
  // lease has already been reclaimed by another. Not the caller's fault, and not retriable as-is.
  run_not_running: 409,
  turn_not_found: 404,
};

const DELIVERY_DENIAL_STATUS: Readonly<Record<DeliveryDenial, number>> = {
  run_not_found: 404,
  run_not_running: 409,
  // The Run exists and is live, but it was not minted by an Integration delivery. Nothing about
  // waiting or retrying changes that, so it is the caller's mistake rather than a conflict.
  not_a_delivery: 400,
  // The Integration was disconnected, removed, or lost its handler after the delivery was
  // acknowledged. The delivery stays stored; there is simply nobody left to interpret it.
  integration_unavailable: 409,
};

const ToolCallSchema = {
  type: "object",
  required: ["callId", "name"],
  additionalProperties: false,
  properties: {
    callId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    arguments: {},
  },
} as const;

const RunParamsSchema = {
  type: "object",
  required: ["runId"],
  properties: { runId: { type: "string", minLength: 1 } },
} as const;

export interface InternalTurnRouteDeps {
  readonly host: InternalTurnHost;
  /**
   * The channel side of the same boundary. Absent in a deployment that composes no Integration
   * ingress at all, in which case the delivery routes are simply not registered.
   *
   * Built from the app's logger, which does not exist until the app does: a delivery that is
   * ignored, refused, or answered with a bind link says so through the same Pino instance as
   * everything else, rather than through a second logger nobody is watching.
   */
  deliveries?(log: FastifyBaseLogger): IngressDeliveryHost;
  /**
   * The Soul's LLM configuration, read fresh on every call so a `soul.synced` reload reaches the
   * Worker. It names providers and `api_key_ref`s, never a credential: the Worker resolves those
   * refs against the encrypted secret store itself, so the key material never crosses this hop.
   */
  llmConfig(): unknown;
}

export function registerInternalTurnRoutes(
  app: FastifyInstance,
  deps: InternalTurnRouteDeps,
  requireAuth: PreHandler
): void {
  /** Refuses anything but a service principal, whatever credential got it past `requireAuth`. */
  const requireService: PreHandler = async (req, reply) => {
    if (req.principal?.kind !== "service") {
      await reply.code(403).send({ error: "internal turn host is service-only" });
    }
  };
  const preHandler = [requireAuth, requireService];

  const guard = async <T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TurnAuthorityError) {
        await reply.code(DENIAL_STATUS[error.code]).send({ error: error.code });
        return undefined;
      }
      if (error instanceof DeliveryDeniedError) {
        await reply.code(DELIVERY_DENIAL_STATUS[error.code]).send({ error: error.code });
        return undefined;
      }
      throw error;
    }
  };

  app.get(
    "/api/v1/internal/llm/config",
    {
      preHandler,
      schema: {
        description:
          "The Soul's LLM configuration, so the Worker can build the same tiered provider chain " +
          "this app uses. Provider credentials are named by reference, not carried — the Worker " +
          "resolves them against the encrypted secret store. Empty when no config is published.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: { type: "object", additionalProperties: true },
          204: { type: "null", description: "No LLM configuration is published." },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const config = deps.llmConfig();
      if (config === undefined || config === null) return reply.code(204).send();
      return reply.send(config);
    }
  );

  app.get(
    "/api/v1/internal/turns/:runId",
    {
      preHandler,
      schema: {
        description:
          "Which Turn the Run is answering, and on which attempt. A Run superseded by a retry " +
          "names no Turn and is refused here, so a worker still holding it learns that before it " +
          "writes an event or spends a model call.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        response: {
          200: {
            type: "object",
            required: ["turnId", "conversationId", "attempt"],
            properties: {
              turnId: { type: "string" },
              conversationId: { type: "string" },
              attempt: { type: "integer" },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const identity = await guard(reply, () =>
        deps.host.describeTurn(DEPLOYMENT_BUSINESS_ID, runId)
      );
      if (identity === undefined) return;
      return reply.send(identity);
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/context",
    {
      preHandler,
      schema: {
        description:
          "Resolve everything one turn's model call needs: the assembled system prompt, the " +
          "durable transcript, the Tools this Run's Agent may call, and the Context and guardrail " +
          "digests that record what was given. Service principals only; the Agent and every " +
          "per-turn parameter come from the Run's immutable request Artifact, never from the caller.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        response: {
          200: {
            type: "object",
            required: [
              "agentId",
              "subjectId",
              "modelProfileId",
              "contextDigest",
              "guardrailDigest",
              "guardrailPolicy",
              "messages",
              "tools",
              "limits",
              "compacted",
            ],
            properties: {
              agentId: { type: "string" },
              subjectId: { type: "string" },
              modelProfileId: { type: "string" },
              contextDigest: { type: "string" },
              guardrailDigest: { type: "string" },
              guardrailPolicy: { type: "object", additionalProperties: true },
              messages: {
                type: "array",
                items: {
                  type: "object",
                  required: ["role", "content"],
                  properties: { role: { type: "string" }, content: { type: "string" } },
                },
              },
              tools: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "inputSchema", "tier"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    inputSchema: { type: "object", additionalProperties: true },
                    tier: { type: "string" },
                  },
                },
              },
              limits: {
                type: "object",
                required: ["maxIterations", "maxToolCalls", "maxRepairAttempts"],
                properties: {
                  maxIterations: { type: "integer" },
                  maxToolCalls: { type: "integer" },
                  maxRepairAttempts: { type: "integer" },
                },
              },
              compacted: { type: "boolean" },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const context = await guard(reply, () =>
        deps.host.resolveContext(DEPLOYMENT_BUSINESS_ID, runId)
      );
      if (context === undefined) return;
      return reply.send(context);
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/tools",
    {
      preHandler,
      schema: {
        description:
          "Execute one Tool call for a Run. The Tool runs as the Run's recorded subject; a Tool " +
          "outside this Agent's allowlist is denied and malformed arguments are refused, both as " +
          "a result the model reads rather than an error that ends the turn.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        body: ToolCallSchema,
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: {
              status: {
                type: "string",
                enum: ["succeeded", "denied", "invalid_arguments", "failed", "awaiting_approval"],
              },
              output: {},
              reason: { type: "string" },
              approvalId: { type: "string" },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const result = await guard(reply, () =>
        deps.host.dispatchTool(DEPLOYMENT_BUSINESS_ID, runId, req.body as HostedToolCall)
      );
      if (result === undefined) return;
      return reply.send(result);
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/approvals/:approvalId/wait",
    {
      preHandler,
      schema: {
        description:
          "Park a Run on the durable wait for an approval it already requested. Who may decide " +
          "the approval is taken from the Run's recorded subject, never from the caller. " +
          "Idempotent: a redelivered park returns the wait the Run is already on.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: {
          type: "object",
          required: ["runId", "approvalId"],
          properties: {
            runId: { type: "string", minLength: 1 },
            approvalId: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["stateKey"],
          additionalProperties: false,
          properties: { stateKey: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["waitId"],
            properties: { waitId: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId, approvalId } = req.params as { runId: string; approvalId: string };
      const { stateKey } = req.body as { stateKey: string };
      const registered = await guard(reply, () =>
        deps.host.registerApprovalWait(DEPLOYMENT_BUSINESS_ID, runId, { stateKey, approvalId })
      );
      if (registered === undefined) return;
      return reply.send(registered);
    }
  );

  app.get(
    "/api/v1/internal/turns/:runId/completion",
    {
      preHandler,
      schema: {
        description:
          "What a given attempt already recorded for this Run's Turn, so a redelivered job " +
          "reports the answer that exists instead of producing a second one. 204 when the " +
          "attempt has recorded nothing yet.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        querystring: {
          type: "object",
          required: ["attempt"],
          additionalProperties: false,
          properties: { attempt: { type: "integer", minimum: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["turnId", "attempt", "status", "messageId", "cursor"],
            properties: {
              turnId: { type: "string" },
              attempt: { type: "integer" },
              status: { type: "string", enum: ["succeeded", "failed"] },
              messageId: { type: ["string", "null"] },
              cursor: { type: "integer" },
            },
          },
          204: { type: "null", description: "This attempt has recorded no outcome yet." },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const { attempt } = req.query as { attempt: number };
      const completion = await guard(reply, () =>
        deps.host.findCompletion(DEPLOYMENT_BUSINESS_ID, runId, attempt)
      );
      if (completion === undefined) return reply.code(204).send();
      return reply.send({
        turnId: completion.turnId,
        attempt: completion.attempt,
        status: completion.status,
        messageId: completion.messageId,
        cursor: completion.cursor,
      });
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/messages",
    {
      preHandler,
      schema: {
        description:
          "Append this attempt's assistant Message to the Run's Turn. The Message becomes part of " +
          "the conversation only once a completion names it, so an attempt that dies here leaves " +
          "a row nobody reads rather than a second answer.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        body: {
          type: "object",
          required: ["attempt", "content"],
          additionalProperties: false,
          properties: {
            attempt: { type: "integer", minimum: 1 },
            content: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["messageId"],
            properties: { messageId: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const body = req.body as { attempt: number; content: string };
      const appended = await guard(reply, () =>
        deps.host.appendAssistantMessage({
          businessId: DEPLOYMENT_BUSINESS_ID,
          runId,
          attempt: body.attempt,
          content: body.content,
        })
      );
      if (appended === undefined) return;
      return reply.send(appended);
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/completion",
    {
      preHandler,
      schema: {
        description:
          "Record how this attempt left the Run's Turn, and the Run event cursor a reader should " +
          "resume after. The first write for an attempt wins, so a redelivered completion leaves " +
          "the recorded answer — and the Message it names — exactly as it stands.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        body: {
          type: "object",
          required: ["attempt", "status", "cursor"],
          additionalProperties: false,
          properties: {
            attempt: { type: "integer", minimum: 1 },
            status: { type: "string", enum: ["succeeded", "failed"] },
            cursor: { type: "integer", minimum: 0 },
            messageId: { type: ["string", "null"] },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const body = req.body as {
        attempt: number;
        status: "succeeded" | "failed";
        cursor: number;
        messageId?: string | null;
      };
      const recorded = await guard(reply, async () => {
        await deps.host.completeTurn({
          businessId: DEPLOYMENT_BUSINESS_ID,
          runId,
          attempt: body.attempt,
          status: body.status,
          cursor: body.cursor,
          messageId: body.messageId ?? null,
        });
        return true;
      });
      if (recorded === undefined) return;
      return reply.send({ status: "recorded" });
    }
  );

  const deliveries = deps.deliveries?.(app.log);
  if (deliveries === undefined) return;

  app.get(
    "/api/v1/internal/deliveries/:runId",
    {
      preHandler,
      schema: {
        description:
          "Everything needed to classify one Integration delivery: the envelope as received, the " +
          "Integration's classifier module with the hash the sandbox must verify, and whether " +
          "this thread is already mapped to a Conversation. All of it is derived from the Run's " +
          "immutable request Artifact, so a caller cannot claim a delivery arrived elsewhere.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        response: {
          200: {
            type: "object",
            required: ["slug", "body", "headers", "classifier", "hasThreadMapping"],
            properties: {
              slug: { type: "string" },
              body: { type: "object", additionalProperties: true },
              headers: { type: "object", additionalProperties: { type: "string" } },
              classifier: {
                type: "object",
                required: ["source", "hash"],
                properties: { source: { type: "string" }, hash: { type: "string" } },
              },
              hasThreadMapping: { type: "boolean" },
              chatEnabled: { type: "boolean" },
              eventsEnabled: { type: "boolean" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const described = await guard(reply, () =>
        deliveries.describe(DEPLOYMENT_BUSINESS_ID, runId)
      );
      if (described === undefined) return;
      return reply.send(described);
    }
  );

  app.post(
    "/api/v1/internal/deliveries/:runId/chat",
    {
      preHandler,
      schema: {
        description:
          "Attach a Chat Turn to this delivery's Run, resolving the sender to an account first. " +
          "An unlinked sender gets no Turn and no model call — a single-use bind link is posted " +
          "back to the channel from this app, so the link never crosses to the caller. Idempotent: " +
          "a Run that already names a Turn returns it rather than re-posting the message.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        body: {
          type: "object",
          required: ["sender", "text", "reply"],
          additionalProperties: false,
          properties: {
            sender: { type: "string", minLength: 1 },
            text: { type: "string" },
            requireExistingThread: { type: "boolean" },
            reply: {
              type: "object",
              required: ["binding"],
              additionalProperties: false,
              properties: {
                binding: { type: "string", minLength: 1 },
                vars: { type: "object", additionalProperties: { type: "string" } },
              },
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: {
              outcome: { type: "string", enum: ["attached", "unlinked", "ignored"] },
              turnId: { type: "string" },
              attempt: { type: "integer" },
              reason: { type: "string" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const body = req.body as Parameters<IngressDeliveryHost["attachChat"]>[2];
      const attached = await guard(reply, () =>
        deliveries.attachChat(DEPLOYMENT_BUSINESS_ID, runId, body)
      );
      if (attached === undefined) return;
      return reply.send(attached);
    }
  );

  app.post(
    "/api/v1/internal/deliveries/:runId/events",
    {
      preHandler,
      schema: {
        description:
          "Record an `event` classification for this delivery and raise the domain event Routine " +
          "triggers subscribe to. An event type the Integration manifest does not declare is " +
          "ignored rather than recorded.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        body: {
          type: "object",
          required: ["eventType"],
          additionalProperties: false,
          properties: {
            eventType: { type: "string", minLength: 1 },
            payload: { type: "object", additionalProperties: true },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["outcome"],
            properties: {
              outcome: { type: "string", enum: ["recorded", "ignored"] },
              eventId: { type: "string" },
              reason: { type: "string" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const body = req.body as { eventType: string; payload?: Record<string, unknown> };
      const recorded = await guard(reply, () =>
        deliveries.recordEvent(DEPLOYMENT_BUSINESS_ID, runId, body)
      );
      if (recorded === undefined) return;
      return reply.send(recorded);
    }
  );

  app.post(
    "/api/v1/internal/deliveries/:runId/reply",
    {
      preHandler,
      schema: {
        description:
          "Post this attempt's answer back to the channel through the Integration's declared " +
          "reply binding. The text is the assistant Message the attempt's completion names, read " +
          "from the durable conversation — the caller states which attempt finished and how, and " +
          "cannot supply wording.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: RunParamsSchema,
        body: {
          type: "object",
          required: ["attempt", "outcome", "binding"],
          additionalProperties: false,
          properties: {
            attempt: { type: "integer", minimum: 1 },
            outcome: { type: "string", enum: ["answered", "blocked", "failed"] },
            binding: { type: "string", minLength: 1 },
            vars: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["delivered"],
            properties: { delivered: { type: "boolean" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const body = req.body as {
        attempt: number;
        outcome: ReplyOutcome;
        binding: string;
        vars?: Record<string, string>;
      };
      const posted = await guard(reply, () =>
        deliveries.postReplyForAttempt(DEPLOYMENT_BUSINESS_ID, runId, body)
      );
      if (posted === undefined) return;
      return reply.send(posted);
    }
  );
}
