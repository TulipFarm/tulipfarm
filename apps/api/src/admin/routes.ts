import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";
import * as AdminSchemas from "./schemas";
import type {
  AgentChangesetInput,
  GuardrailChangesetInput,
  OperationalApiDeps,
  OperationalGrant,
  OperationalPermission,
} from "./types";

export type {
  AgentChangesetInput,
  ApprovalDecisionInput,
  GuardrailChangesetInput,
  GuardrailsReadModel,
  InboxItemReadModel,
  OperationalApiDeps,
  OperationalGrant,
  OperationalPermission,
  OperationsReadModel,
  RolesReadModel,
  RunBudgetReadModel,
  RunCommandAction,
  RunCommandInput,
  RunReadModel,
  RunStateReadModel,
} from "./types";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export class OperationalNotImplementedError extends Error {
  readonly name = "OperationalNotImplementedError";
}

const security: { [securityLabel: string]: readonly string[] }[] = [
  { sessionCookie: [] },
  { bearerToken: [] },
];
const missingKeyMessage = "An Idempotency-Key header is required.";

function fail(
  reply: FastifyReply,
  request: FastifyRequest,
  status: 400 | 403 | 404 | 409 | 501,
  code: string,
  message: string,
  retryable = false
) {
  return reply.code(status).send({
    error: {
      version: "1",
      code,
      message,
      correlationId: request.id,
      retryable,
    },
  });
}

async function requireGrant(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OperationalApiDeps,
  permission: OperationalPermission
): Promise<OperationalGrant | null> {
  const grant = await deps.authorize(request);
  if (!grant?.permissions.includes(permission)) {
    fail(reply, request, 403, "forbidden", "You do not have access to this operation.");
    return null;
  }
  return grant;
}

/**
 * Runs a command against the deps, translating {@link OperationalNotImplementedError} into the
 * `501` envelope. Returns `undefined` when it replied, so the caller returns without sending twice.
 */
async function attemptCommand<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  command: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await command();
  } catch (error) {
    if (!(error instanceof OperationalNotImplementedError)) throw error;
    fail(reply, request, 501, "not_implemented", error.message);
    return undefined;
  }
}

function idempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function registerOperationalRoutes(
  app: FastifyInstance,
  deps: OperationalApiDeps,
  requireAuth: PreHandler,
  rateLimiter?: RateLimiter
): void {
  const rateLimitHook = rateLimiter
    ? makeRateLimitHook(rateLimiter, (request) => `rl:operations:${request.ip}`, 120, 60_000)
    : undefined;
  const limitedAuth: PreHandler[] = rateLimitHook ? [rateLimitHook, requireAuth] : [requireAuth];

  app.get(
    "/api/v1/runs",
    {
      preHandler: limitedAuth,
      schema: {
        description: "List authorized Run read models for the operational browser UI.",
        tags: ["runs"],
        security,
        querystring: AdminSchemas.AdminRunListQuerystringSchema,
        response: AdminSchemas.AdminRunListResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "runs:read");
      if (!grant) return;
      const query = request.query as { cursor?: string; limit?: number };
      return deps.listRuns(grant, { cursor: query.cursor, limit: query.limit ?? 50 });
    }
  );

  app.get(
    "/api/v1/runs/:id",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Get an authorized Run inspector read model with States, effects, waits, costs, " +
          "Guardrail decisions, and lineage.",
        tags: ["runs"],
        security,
        params: AdminSchemas.AdminIdParamsSchema,
        response: AdminSchemas.AdminRunResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "runs:read");
      if (!grant) return;
      const { id } = request.params as { id: string };
      const run = await deps.getRun(grant, id);
      if (!run) return fail(reply, request, 404, "run_not_found", "Run not found.");
      return { run };
    }
  );

  app.get(
    "/api/v1/runs/:id/budgets",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Read the write-once budget ledger for one Run: per limit key, the committed ceiling, " +
          "the amount consumed against it, and the exhaustion policy applied once it is spent. " +
          "This is the enforced `run_budgets` ledger, not a recomputation. A Run with no ledger " +
          "rows is unbounded and returns an empty list. An unknown Run and a Run owned by another " +
          "business are indistinguishable — both answer 404 — so the route is not an existence " +
          "oracle.",
        tags: ["runs"],
        security,
        params: AdminSchemas.AdminIdParamsSchema,
        response: AdminSchemas.AdminRunBudgetsResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "runs:read");
      if (!grant) return;
      const { id } = request.params as { id: string };
      const budgets = await deps.getRunBudgets(grant, id);
      if (!budgets) return fail(reply, request, 404, "run_not_found", "Run not found.");
      return { runId: id, budgets };
    }
  );

  for (const action of ["pause", "resume", "cancel", "retry", "reconcile"] as const) {
    app.post(
      `/api/v1/runs/:id/${action}`,
      {
        preHandler: limitedAuth,
        schema: {
          description:
            `Request a server-authorized ${action} command for one Run. ` +
            "The browser supplies presentation intent only; the Run authority validates it.",
          tags: ["runs"],
          security,
          params: AdminSchemas.AdminIdParamsSchema,
          headers: AdminSchemas.AdminIdempotencyKeyHeadersSchema,
          body: AdminSchemas.AdminRunCommandBodySchema,
          response: AdminSchemas.AdminRunCommandResponsesSchema,
        },
      },
      async (request, reply) => {
        const grant = await requireGrant(request, reply, deps, "runs:control");
        if (!grant) return;
        const key = idempotencyKey(request);
        if (!key) return fail(reply, request, 400, "idempotency_key_required", missingKeyMessage);
        const { id } = request.params as { id: string };
        const body = request.body as { expectedVersion: number; reason: string };
        const result = await attemptCommand(request, reply, () =>
          deps.commandRun(grant, {
            action,
            runId: id,
            expectedVersion: body.expectedVersion,
            reason: body.reason,
            idempotencyKey: key,
          })
        );
        if (!result) return;
        return reply.code(202).send(result);
      }
    );
  }

  app.get(
    "/api/v1/admin/operations",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Authorized, redacted operations read model: health, incidents, quarantine, kill " +
          "switches, audit summaries, and recovery posture.",
        tags: ["admin"],
        security,
        response: AdminSchemas.AdminOperationsResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "operations:read");
      if (!grant) return;
      return deps.getOperations(grant);
    }
  );

  app.get(
    "/api/v1/guardrails",
    {
      preHandler: limitedAuth,
      schema: {
        description: "Get the authorized Guardrail administration read model.",
        tags: ["guardrails"],
        security,
        response: AdminSchemas.AdminGuardrailsResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "guardrails:read");
      if (!grant) return;
      return deps.getGuardrails(grant);
    }
  );

  app.post(
    "/api/v1/guardrails/changesets",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Propose a Guardrail change through the Soul changeset validation, Approval, and " +
          "publication authority. This endpoint never writes Guardrails directly.",
        tags: ["guardrails", "soul"],
        security,
        headers: AdminSchemas.AdminIdempotencyKeyHeadersSchema,
        body: AdminSchemas.AdminGuardrailChangesetBodySchema,
        response: AdminSchemas.AdminGuardrailChangesetResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "guardrails:write");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(reply, request, 400, "idempotency_key_required", missingKeyMessage);
      }
      const body = request.body as Omit<GuardrailChangesetInput, "idempotencyKey">;
      const result = await attemptCommand(request, reply, () =>
        deps.proposeGuardrailChangeset(grant, { ...body, idempotencyKey: key })
      );
      if (!result) return;
      return reply.code(202).send(result);
    }
  );

  app.post(
    "/api/v1/agents/:id/changesets",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Propose an exact Agent candidate through the Soul validation, evaluation, Approval, " +
          "and publication authority. The browser cannot publish or write Agent files directly.",
        tags: ["agents", "soul"],
        security,
        params: AdminSchemas.AdminIdParamsSchema,
        headers: AdminSchemas.AdminIdempotencyKeyHeadersSchema,
        body: AdminSchemas.AdminAgentChangesetBodySchema,
        response: AdminSchemas.AdminAgentChangesetResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "agents:write");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(reply, request, 400, "idempotency_key_required", missingKeyMessage);
      }
      const { id } = request.params as { id: string };
      const body = request.body as Omit<AgentChangesetInput, "agentId" | "idempotencyKey">;
      const result = await attemptCommand(request, reply, () =>
        deps.proposeAgentChangeset(grant, { ...body, agentId: id, idempotencyKey: key })
      );
      if (!result) return;
      return reply.code(202).send(result);
    }
  );

  app.get(
    "/api/v1/inbox",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Unified authorized inbox for Approvals, human tasks, form waits, and access requests. " +
          "Form content and protected intent payloads remain on their owning data planes.",
        tags: ["approvals"],
        security,
        response: AdminSchemas.AdminInboxResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "approvals:read");
      if (!grant) return;
      return deps.getInbox(grant);
    }
  );

  app.post(
    "/api/v1/approvals/:id/decisions",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Record one server-authorized decision for the exact persisted Approval binding. " +
          "The request cannot replace the intent, target, destination, or Guardrail revision.",
        tags: ["approvals"],
        security,
        params: AdminSchemas.AdminIdParamsSchema,
        headers: AdminSchemas.AdminIdempotencyKeyHeadersSchema,
        body: AdminSchemas.AdminApprovalDecisionBodySchema,
        response: AdminSchemas.AdminApprovalDecisionResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "approvals:decide");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(reply, request, 400, "idempotency_key_required", missingKeyMessage);
      }
      const { id } = request.params as { id: string };
      const body = request.body as {
        decision: "approved" | "denied";
        comment?: string;
      };
      return deps.decideApproval(grant, {
        approvalId: id,
        decision: body.decision,
        comment: body.comment,
        idempotencyKey: key,
      });
    }
  );

  app.get(
    "/api/v1/roles",
    {
      preHandler: limitedAuth,
      schema: {
        description: "Get authorized custom Role summaries and scoped grants.",
        tags: ["roles"],
        security,
        response: AdminSchemas.AdminRolesResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "roles:read");
      if (!grant) return;
      return deps.getRoles(grant);
    }
  );

  app.post(
    "/api/v1/roles/changesets",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Propose a custom Role through the Soul changeset authority. The route cannot assign " +
          "or broaden authority directly.",
        tags: ["roles", "soul"],
        security,
        headers: AdminSchemas.AdminIdempotencyKeyHeadersSchema,
        body: AdminSchemas.AdminRoleChangesetBodySchema,
        response: AdminSchemas.AdminRoleChangesetResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "roles:write");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(reply, request, 400, "idempotency_key_required", missingKeyMessage);
      }
      const body = request.body as {
        baseRevision: string;
        role: Record<string, unknown>;
      };
      const result = await attemptCommand(request, reply, () =>
        deps.proposeRoleChangeset(grant, { ...body, idempotencyKey: key })
      );
      if (!result) return;
      return reply.code(202).send(result);
    }
  );

  app.post(
    "/api/v1/admin/operations/:action",
    {
      preHandler: limitedAuth,
      schema: {
        description:
          "Request an audited operational command. The operations authority reauthorizes the " +
          "target and never accepts protected payloads from the browser.",
        tags: ["admin"],
        security,
        params: AdminSchemas.AdminOperationActionParamsSchema,
        headers: AdminSchemas.AdminOperationCommandHeadersSchema,
        body: AdminSchemas.AdminOperationCommandBodySchema,
        response: AdminSchemas.AdminOperationCommandResponsesSchema,
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "operations:control");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(reply, request, 400, "idempotency_key_required", missingKeyMessage);
      }
      const { action } = request.params as {
        action:
          | "support-bundle.create"
          | "kill-switch.set"
          | "quarantine.resolve"
          | "recovery.start";
      };
      const { input } = request.body as { input: Record<string, unknown> };
      const result = await attemptCommand(request, reply, () =>
        deps.commandOperation(grant, { action, parameters: input, idempotencyKey: key })
      );
      if (!result) return;
      return reply.code(202).send(result);
    }
  );
}
