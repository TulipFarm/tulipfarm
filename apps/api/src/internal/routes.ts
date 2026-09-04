import { Readable } from "node:stream";
import type { ModelFailureDiagnostic } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { ParticipantToolCall } from "@tulipfarm/schema";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import * as ChildRoutineHost from "./child-routine-host";
import { registerChildRoutineRoutes } from "./child-routine-routes";
import * as DeliveryHost from "./delivery-host";
import * as EmitHost from "./emit-host";
import { registerEmitRoutes } from "./emit-routes";
import * as RoutineApprovalHost from "./routine-approval-host";
import { registerRoutineApprovalRoutes } from "./routine-approval-routes";
import * as InternalSchemas from "./schemas";
import * as TurnHost from "./turn-host";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const DENIAL_STATUS: Readonly<Record<TurnHost.TurnAuthorityDenial, number>> = {
  run_not_found: 404,
  run_not_running: 409,
  turn_not_found: 404,
};

const DELIVERY_DENIAL_STATUS: Readonly<Record<DeliveryHost.DeliveryDenial, number>> = {
  run_not_found: 404,
  run_not_running: 409,
  not_a_delivery: 400,
  integration_unavailable: 409,
};

const ROUTINE_APPROVAL_DENIAL_STATUS: Readonly<
  Record<RoutineApprovalHost.RoutineApprovalDenial, number>
> = {
  run_not_found: 404,
  run_not_running: 409,
  not_a_routine: 400,
};

const CHILD_ROUTINE_DENIAL_STATUS: Readonly<Record<ChildRoutineHost.ChildRoutineDenial, number>> = {
  run_not_found: 404,
  run_not_running: 409,
  not_a_routine: 400,
  depth_limit_exceeded: 409,
  deadline_not_bounded: 400,
};

const EMIT_DENIAL_STATUS: Readonly<Record<EmitHost.EmitDenial, number>> = {
  run_not_found: 404,
  run_not_running: 409,
  not_a_routine: 400,
  depth_limit_exceeded: 409,
  reserved_event_type: 400,
};

export interface InternalTurnRouteDeps {
  readonly host: TurnHost.InternalTurnHost;
  deliveries?(log: FastifyBaseLogger): DeliveryHost.IngressDeliveryHost;
  llmConfig(): unknown;
  pricingOverrides(): Record<string, { in: number; out: number }>;
  /**
   * Soul manifest and knowledge/memory signals the task reconciler cannot reach directly, since
   * those stores belong to this app, not the Worker (`apps/worker/AGENTS.md`: Soul access is
   * signed-bundle reads only). Optional and read fresh per call, mirroring `llmConfig()` — a
   * deployment that has not wired a supplier yet gets `204`, the same "not published" shape.
   */
  taskReconcileSignals?():
    | Promise<TaskReconcileSignals | undefined>
    | TaskReconcileSignals
    | undefined;
  readonly routineApprovals?: RoutineApprovalHost.InternalRoutineApprovalHost;
  readonly childRoutines?: ChildRoutineHost.InternalChildRoutineHost;
  readonly emissions?: EmitHost.InternalEmitHost;
}

/** Payload for `GET /api/v1/internal/task-reconcile-signals`; see {@link InternalTurnRouteDeps}. */
export interface TaskReconcileSignals {
  readonly businessName?: string;
  readonly businessDescription?: string;
  /** False while the first-run wizard is still in flight; it owns some questions until it ends. */
  readonly setupComplete?: boolean;
  /**
   * Non-disabled users (`active` or `invited`), admin included. Counts a sent-but-unredeemed
   * invite as team growth — unlike the Worker's own `principals` table, which maps `invited` to
   * `disabled` and so cannot tell an invite in flight from a deliberately deactivated account.
   */
  readonly memberCount?: number;
}

export function registerInternalTurnRoutes(
  app: FastifyInstance,
  deps: InternalTurnRouteDeps,
  requireAuth: PreHandler
): void {
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
      if (error instanceof TurnHost.TurnAuthorityError) {
        await reply.code(DENIAL_STATUS[error.code]).send({ error: error.code });
        return undefined;
      }
      if (error instanceof RoutineApprovalHost.RoutineApprovalDeniedError) {
        await reply.code(ROUTINE_APPROVAL_DENIAL_STATUS[error.code]).send({ error: error.code });
        return undefined;
      }
      if (error instanceof ChildRoutineHost.ChildRoutineDeniedError) {
        await reply.code(CHILD_ROUTINE_DENIAL_STATUS[error.code]).send({ error: error.code });
        return undefined;
      }
      if (error instanceof EmitHost.EmitDeniedError) {
        await reply.code(EMIT_DENIAL_STATUS[error.code]).send({ error: error.code });
        return undefined;
      }
      if (error instanceof DeliveryHost.DeliveryDeniedError) {
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
        description: "Read the published LLM config for Worker use.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: InternalSchemas.InternalLlmConfigResponseSchema,
          204: InternalSchemas.InternalLlmConfigEmptyResponseSchema,
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
    "/api/v1/internal/observability/pricing",
    {
      preHandler,
      schema: {
        description: "Read operator pricing overrides for Worker budget checks.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: InternalSchemas.InternalObservabilityPricingResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (_req, reply) => reply.send({ overrides: deps.pricingOverrides() })
  );

  app.get(
    "/api/v1/internal/task-reconcile-signals",
    {
      preHandler,
      schema: {
        description:
          "Soul manifest and memory signals the task reconciler cannot reach directly: business " +
          "name/description, whether first-run setup finished, " +
          "field. Empty (204) until a deployment wires a supplier.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: { type: "object", additionalProperties: true },
          204: { type: "null", description: "No supplier wired yet." },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const signals = await deps.taskReconcileSignals?.();
      if (signals === undefined) return reply.code(204).send();
      return reply.send(signals);
    }
  );

  app.get(
    "/api/v1/internal/turns/:runId",
    {
      preHandler,
      schema: {
        description: "Read the Turn id and attempt for a Run.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        response: {
          200: InternalSchemas.InternalTurnLookupResponseSchema,
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
      if (identity !== undefined) return reply.send(identity);
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/context",
    {
      preHandler,
      schema: {
        description: "Resolve one Turn's model context, Tools, and limits.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        response: {
          200: InternalSchemas.InternalTurnContextResponseSchema,
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
      if (context !== undefined) return reply.send(context);
    }
  );

  app.get(
    "/api/v1/internal/turns/:runId/attachments/:fileId",
    {
      preHandler,
      schema: {
        description: "Read the bytes of one File the named Turn attached.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalTurnAttachmentParamsSchema,
        response: {
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId, fileId } = req.params as { runId: string; fileId: string };
      const attachment = await guard(reply, () =>
        deps.host.readAttachment(DEPLOYMENT_BUSINESS_ID, runId, fileId)
      );
      if (attachment === undefined) return;
      if (attachment === null) return reply.code(404).send({ error: "file not found" });
      return reply
        .header("content-type", attachment.mediaType)
        .header("content-length", String(attachment.sizeBytes))
        .send(Readable.from(attachment.body));
    }
  );

  app.get(
    "/api/v1/internal/turns/:runId/authority",
    {
      preHandler,
      schema: {
        description: "Read the Run-derived authority for one Turn.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        querystring: InternalSchemas.InternalRunAgentQuerySchema,
        response: {
          200: InternalSchemas.InternalTurnAuthorityResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const { agent: claimedAgent } = req.query as { agent?: string };
      const authority = await guard(reply, () =>
        deps.host.authority(DEPLOYMENT_BUSINESS_ID, runId, claimedAgent)
      );
      if (authority !== undefined)
        return reply.send({
          businessId: authority.businessId,
          runId: authority.runId,
          ...(authority.turn === undefined
            ? {}
            : {
                turn: {
                  id: authority.turn.id,
                  conversationId: authority.turn.conversationId,
                  attempt: authority.turn.attempt,
                },
              }),
          subject: authority.subject,
          source: authority.source,
          bundleDigest: authority.bundleDigest,
          ...(authority.routineId === undefined ? {} : { routineId: authority.routineId }),
          ...(authority.agent === undefined ? {} : { agent: authority.agent }),
        });
    }
  );

  app.get(
    "/api/v1/internal/runs/:runId/agent-tools",
    {
      preHandler,
      schema: {
        description: "List the Tools the Run's acting Agent may be offered.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        querystring: InternalSchemas.InternalRunAgentQuerySchema,
        response: {
          200: InternalSchemas.InternalRunAgentToolsResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { runId } = req.params as { runId: string };
      const { agent } = req.query as { agent?: string };
      const tools = await guard(reply, () =>
        deps.host.agentTools(DEPLOYMENT_BUSINESS_ID, runId, agent)
      );
      if (tools !== undefined) return reply.send({ tools });
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/tools",
    {
      preHandler,
      schema: {
        description: "Execute one Tool call as the Run's recorded subject.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalTurnToolCallBodySchema,
        response: {
          200: InternalSchemas.InternalTurnToolResultResponseSchema,
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
        deps.host.dispatchTool(DEPLOYMENT_BUSINESS_ID, runId, req.body as TurnHost.HostedToolCall)
      );
      if (result !== undefined) return reply.send(result);
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/approvals/:approvalId/wait",
    {
      preHandler,
      schema: {
        description: "Park a Run on the durable wait for an approval.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalTurnApprovalWaitParamsSchema,
        body: InternalSchemas.InternalTurnApprovalWaitBodySchema,
        response: {
          200: InternalSchemas.InternalTurnApprovalWaitResponseSchema,
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
      if (registered !== undefined) return reply.send(registered);
    }
  );

  app.get(
    "/api/v1/internal/turns/:runId/completion",
    {
      preHandler,
      schema: {
        description: "Read the recorded completion for one attempt, if any.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        querystring: InternalSchemas.InternalTurnCompletionQuerySchema,
        response: {
          200: InternalSchemas.InternalTurnCompletionResponseSchema,
          204: InternalSchemas.InternalTurnCompletionEmptyResponseSchema,
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
        ...(completion.reason === undefined ? {} : { reason: completion.reason }),
        ...(completion.modelFailure === undefined ? {} : { modelFailure: completion.modelFailure }),
      });
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/messages",
    {
      preHandler,
      schema: {
        description: "Append the assistant Message for this attempt.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalTurnMessageBodySchema,
        response: {
          200: InternalSchemas.InternalTurnMessageResponseSchema,
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
        content: string;
        metadata?: { toolCalls?: ParticipantToolCall[] };
      };
      const appended = await guard(reply, () =>
        deps.host.appendAssistantMessage({
          businessId: DEPLOYMENT_BUSINESS_ID,
          runId,
          attempt: body.attempt,
          content: body.content,
          ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
        })
      );
      if (appended !== undefined) return reply.send(appended);
    }
  );

  app.post(
    "/api/v1/internal/turns/:runId/completion",
    {
      preHandler,
      schema: {
        description: "Record this attempt's completion outcome and cursor.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalTurnCompletionRecordBodySchema,
        response: {
          200: InternalSchemas.InternalTurnCompletionRecordResponseSchema,
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
        surfaces?: { artifactId: string; revision: number }[];
        reason?: string;
        modelFailure?: ModelFailureDiagnostic;
      };
      const recorded = await guard(reply, async () => {
        await deps.host.completeTurn({
          businessId: DEPLOYMENT_BUSINESS_ID,
          runId,
          attempt: body.attempt,
          status: body.status,
          cursor: body.cursor,
          messageId: body.messageId ?? null,
          surfaces: body.surfaces ?? [],
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(body.modelFailure === undefined ? {} : { modelFailure: body.modelFailure }),
        });
        return true;
      });
      if (recorded !== undefined) return reply.send({ status: "recorded" });
    }
  );

  registerRoutineApprovalRoutes(app, deps.routineApprovals, preHandler, guard);
  registerChildRoutineRoutes(app, deps.childRoutines, preHandler, guard);
  registerEmitRoutes(app, deps.emissions, preHandler, guard);

  const deliveries = deps.deliveries?.(app.log);
  if (deliveries === undefined) return;

  app.get(
    "/api/v1/internal/deliveries/:runId",
    {
      preHandler,
      schema: {
        description: "Read the delivery payload, classifier, and mapping state.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        response: {
          200: InternalSchemas.InternalDeliveryDescriptionResponseSchema,
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
      if (described !== undefined) return reply.send(described);
    }
  );

  app.post(
    "/api/v1/internal/deliveries/:runId/chat",
    {
      preHandler,
      schema: {
        description: "Attach a Chat Turn to a delivery Run.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalDeliveryChatAttachmentBodySchema,
        response: {
          200: InternalSchemas.InternalDeliveryChatAttachmentResponseSchema,
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
      const body = req.body as Parameters<DeliveryHost.IngressDeliveryHost["attachChat"]>[2];
      const attached = await guard(reply, () =>
        deliveries.attachChat(DEPLOYMENT_BUSINESS_ID, runId, body)
      );
      if (attached !== undefined) return reply.send(attached);
    }
  );

  app.post(
    "/api/v1/internal/deliveries/:runId/events",
    {
      preHandler,
      schema: {
        description: "Record a classified delivery event if the manifest allows it.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalDeliveryEventBodySchema,
        response: {
          200: InternalSchemas.InternalDeliveryEventResponseSchema,
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
      if (recorded !== undefined) return reply.send(recorded);
    }
  );

  app.post(
    "/api/v1/internal/deliveries/:runId/reply",
    {
      preHandler,
      schema: {
        description: "Post a completed attempt's reply back to the channel.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: InternalSchemas.InternalRunParamsSchema,
        body: InternalSchemas.InternalDeliveryReplyBodySchema,
        response: {
          200: InternalSchemas.InternalDeliveryReplyResponseSchema,
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
        outcome: DeliveryHost.ReplyOutcome;
        binding: string;
        vars?: Record<string, string>;
      };
      const posted = await guard(reply, () =>
        deliveries.postReplyForAttempt(DEPLOYMENT_BUSINESS_ID, runId, body)
      );
      if (posted !== undefined) return reply.send(posted);
    }
  );
}
