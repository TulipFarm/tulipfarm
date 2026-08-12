import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type OperationalPermission =
  | "runs:read"
  | "runs:control"
  | "operations:read"
  | "guardrails:read"
  | "guardrails:write"
  | "agents:write"
  | "approvals:read"
  | "approvals:decide"
  | "roles:read"
  | "roles:write"
  | "operations:control";

export interface OperationalGrant {
  readonly businessId: string;
  readonly principalId: string;
  readonly permissions: readonly OperationalPermission[];
}

export interface RunStateReadModel {
  readonly key: string;
  readonly status: string;
  readonly attempts: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly errorEvidenceRef?: string;
}

export interface RunReadModel {
  readonly id: string;
  readonly routineId: string;
  readonly routineVersion: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly states: readonly RunStateReadModel[];
  readonly effects: readonly Record<string, unknown>[];
  readonly waits: readonly Record<string, unknown>[];
  readonly guardrailDecisions: readonly Record<string, unknown>[];
  readonly lineage: readonly Record<string, unknown>[];
  readonly costs: { readonly amountUsd: number; readonly modelTokens: number };
}

export type RunCommandAction = "pause" | "resume" | "cancel" | "retry" | "reconcile";

export interface RunCommandInput {
  readonly action: RunCommandAction;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface OperationsReadModel {
  readonly health: readonly Record<string, unknown>[];
  readonly incidents: readonly Record<string, unknown>[];
  readonly quarantine: readonly Record<string, unknown>[];
  readonly killSwitches: readonly Record<string, unknown>[];
  /**
   * Recent *activity-feed* entries — not audit-ledger events.
   *
   * Named `activity` deliberately: this field used to be called `audit` and rendered under an
   * "Audit" heading, while being populated from `ActivityService`, a cosmetic UI feed with no
   * hash chain, no reason codes and no append-only guarantee. An operator asking "who repointed
   * the Soul git remote" would read it and get an answer that had never been through the ledger.
   * The real ledger is `audit_events`, exposed at `GET /api/v1/audit/events`.
   */
  readonly activity: readonly Record<string, unknown>[];
  readonly recovery: {
    readonly supportBundleAvailable: boolean;
    readonly lastBackupAt: string | null;
  };
}

export interface GuardrailsReadModel {
  readonly revision: string;
  readonly items: readonly Record<string, unknown>[];
}

export interface GuardrailChangesetInput {
  readonly baseRevision: string;
  readonly changes: readonly {
    readonly op: "add" | "remove" | "replace";
    readonly path: string;
    readonly value?: unknown;
  }[];
  readonly idempotencyKey: string;
}

export interface AgentChangesetInput {
  readonly agentId: string;
  readonly baseVersion: string;
  readonly candidateVersion: string;
  readonly patch: Record<string, unknown>;
  readonly idempotencyKey: string;
}

export interface InboxItemReadModel {
  readonly id: string;
  readonly kind: "approval" | "human_task" | "form" | "access_request";
  readonly title: string;
  readonly status: string;
  readonly risk: "low" | "medium" | "high";
  readonly intentDigest?: string;
  readonly guardrailRevision?: string;
  readonly target?: string;
  readonly destination?: string;
  readonly fields?: readonly string[];
  readonly expiresAt?: string;
  readonly decisions: number;
  readonly requiredDecisions: number;
  readonly canDecide: boolean;
  readonly denialReason?: string;
}

export interface ApprovalDecisionInput {
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
  readonly comment?: string;
  readonly idempotencyKey: string;
}

export interface RolesReadModel {
  readonly revision: string;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly principalKinds: readonly string[];
    readonly grants: readonly string[];
    readonly conditions: readonly string[];
  }[];
}

export interface OperationalApiDeps {
  authorize(req: FastifyRequest): Promise<OperationalGrant | null>;
  listRuns(
    grant: OperationalGrant,
    options: { cursor?: string; limit: number }
  ): Promise<{ items: readonly RunReadModel[]; nextCursor: string | null }>;
  getRun(grant: OperationalGrant, runId: string): Promise<RunReadModel | null>;
  commandRun(
    grant: OperationalGrant,
    input: RunCommandInput
  ): Promise<{ commandId: string; runId: string; status: "accepted" | "duplicate" }>;
  getOperations(grant: OperationalGrant): Promise<OperationsReadModel>;
  getGuardrails(grant: OperationalGrant): Promise<GuardrailsReadModel>;
  proposeGuardrailChangeset(
    grant: OperationalGrant,
    input: GuardrailChangesetInput
  ): Promise<{
    changesetId: string;
    status: "validated" | "awaiting_approval" | "published";
  }>;
  proposeAgentChangeset(
    grant: OperationalGrant,
    input: AgentChangesetInput
  ): Promise<{
    changesetId: string;
    candidateVersion: string;
    status: "validated" | "awaiting_approval" | "published";
  }>;
  getInbox(grant: OperationalGrant): Promise<{ items: readonly InboxItemReadModel[] }>;
  decideApproval(
    grant: OperationalGrant,
    input: ApprovalDecisionInput
  ): Promise<{
    approvalId: string;
    status: "pending" | "approved" | "denied";
    decisions: number;
    requiredDecisions: number;
  }>;
  getRoles(grant: OperationalGrant): Promise<RolesReadModel>;
  proposeRoleChangeset(
    grant: OperationalGrant,
    input: {
      baseRevision: string;
      role: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<{
    changesetId: string;
    status: "validated" | "awaiting_approval" | "published";
  }>;
  commandOperation(
    grant: OperationalGrant,
    input: {
      action: "support-bundle.create" | "kill-switch.set" | "quarantine.resolve" | "recovery.start";
      parameters: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<{ commandId: string; status: "accepted" | "duplicate" }>;
}

/**
 * Raised by an `OperationalApiDeps` implementation for a command this deployment cannot carry out
 * yet, so the route answers `501 not_implemented` with the reason instead of a `500` that reads
 * like a bug. Authorization is unaffected — the caller has the authority, the capability is absent.
 */
export class OperationalNotImplementedError extends Error {
  readonly name = "OperationalNotImplementedError";

  constructor(reason: string) {
    super(reason);
  }
}

const security: { [securityLabel: string]: readonly string[] }[] = [
  { sessionCookie: [] },
  { bearerToken: [] },
];
const idParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;
/*
 * Two shapes reach the client under these status codes. The route's own failures use the versioned
 * envelope below. The shared auth and CSRF preHandlers reject before the handler runs and send a
 * plain `{ error: "reason" }`, which is the API-wide contract — the schema must accept it too, or
 * the response serializer turns an ordinary 403 into a 500.
 */
const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: false,
          required: ["version", "code", "message", "correlationId", "retryable"],
          properties: {
            version: { type: "string", const: "1" },
            code: { type: "string" },
            message: { type: "string" },
            correlationId: { type: "string" },
            retryable: { type: "boolean" },
          },
        },
      ],
    },
  },
} as const;

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

const runSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "id",
    "routineId",
    "routineVersion",
    "status",
    "version",
    "createdAt",
    "startedAt",
    "finishedAt",
    "states",
    "effects",
    "waits",
    "guardrailDecisions",
    "lineage",
    "costs",
  ],
  properties: {
    id: { type: "string" },
    routineId: { type: "string" },
    routineVersion: { type: "string" },
    status: { type: "string" },
    version: { type: "integer" },
    createdAt: { type: "string" },
    startedAt: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
    states: { type: "array", items: { type: "object", additionalProperties: true } },
    effects: { type: "array", items: { type: "object", additionalProperties: true } },
    waits: { type: "array", items: { type: "object", additionalProperties: true } },
    guardrailDecisions: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    lineage: { type: "array", items: { type: "object", additionalProperties: true } },
    costs: {
      type: "object",
      required: ["amountUsd", "modelTokens"],
      properties: { amountUsd: { type: "number" }, modelTokens: { type: "number" } },
    },
  },
} as const;

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
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: {
              items: { type: "array", items: runSchema },
              nextCursor: { type: ["string", "null"] },
            },
          },
          403: errorSchema,
        },
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
        params: idParams,
        response: {
          200: {
            type: "object",
            required: ["run"],
            properties: { run: runSchema },
          },
          403: errorSchema,
          404: errorSchema,
        },
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
          params: idParams,
          headers: {
            type: "object",
            properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
          },
          body: {
            type: "object",
            additionalProperties: false,
            required: ["expectedVersion", "reason"],
            properties: {
              expectedVersion: { type: "integer", minimum: 0 },
              reason: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
          response: {
            202: {
              type: "object",
              required: ["commandId", "runId", "status"],
              properties: {
                commandId: { type: "string" },
                runId: { type: "string" },
                status: { type: "string", enum: ["accepted", "duplicate"] },
              },
            },
            400: errorSchema,
            403: errorSchema,
            404: errorSchema,
            409: errorSchema,
            501: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const grant = await requireGrant(request, reply, deps, "runs:control");
        if (!grant) return;
        const key = idempotencyKey(request);
        if (!key) {
          return fail(
            reply,
            request,
            400,
            "idempotency_key_required",
            "An Idempotency-Key header is required."
          );
        }
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
        response: {
          200: { type: "object", additionalProperties: true },
          403: errorSchema,
        },
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
        response: {
          200: {
            type: "object",
            required: ["revision", "items"],
            properties: {
              revision: { type: "string" },
              items: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          403: errorSchema,
        },
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
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["baseRevision", "changes"],
          properties: {
            baseRevision: { type: "string", minLength: 1 },
            changes: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["op", "path"],
                properties: {
                  op: { type: "string", enum: ["add", "remove", "replace"] },
                  path: { type: "string", minLength: 1 },
                  value: {},
                },
              },
            },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["changesetId", "status"],
            properties: {
              changesetId: { type: "string" },
              status: {
                type: "string",
                enum: ["validated", "awaiting_approval", "published"],
              },
            },
          },
          400: errorSchema,
          403: errorSchema,
          409: errorSchema,
          501: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "guardrails:write");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(
          reply,
          request,
          400,
          "idempotency_key_required",
          "An Idempotency-Key header is required."
        );
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
        params: idParams,
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["baseVersion", "candidateVersion", "patch"],
          properties: {
            baseVersion: { type: "string", minLength: 1 },
            candidateVersion: { type: "string", minLength: 1 },
            patch: { type: "object", additionalProperties: true },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["changesetId", "candidateVersion", "status"],
            properties: {
              changesetId: { type: "string" },
              candidateVersion: { type: "string" },
              status: {
                type: "string",
                enum: ["validated", "awaiting_approval", "published"],
              },
            },
          },
          400: errorSchema,
          403: errorSchema,
          409: errorSchema,
          501: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "agents:write");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(
          reply,
          request,
          400,
          "idempotency_key_required",
          "An Idempotency-Key header is required."
        );
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
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
          403: errorSchema,
        },
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
        params: idParams,
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["approved", "denied"] },
            comment: { type: "string", maxLength: 1000 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["approvalId", "status", "decisions", "requiredDecisions"],
            properties: {
              approvalId: { type: "string" },
              status: { type: "string", enum: ["pending", "approved", "denied"] },
              decisions: { type: "integer" },
              requiredDecisions: { type: "integer" },
            },
          },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "approvals:decide");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(
          reply,
          request,
          400,
          "idempotency_key_required",
          "An Idempotency-Key header is required."
        );
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
        response: {
          200: {
            type: "object",
            required: ["revision", "items"],
            properties: {
              revision: { type: "string" },
              items: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          403: errorSchema,
        },
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
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["baseRevision", "role"],
          properties: {
            baseRevision: { type: "string", minLength: 1 },
            role: { type: "object", additionalProperties: true },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["changesetId", "status"],
            properties: {
              changesetId: { type: "string" },
              status: {
                type: "string",
                enum: ["validated", "awaiting_approval", "published"],
              },
            },
          },
          400: errorSchema,
          403: errorSchema,
          409: errorSchema,
          501: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "roles:write");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(
          reply,
          request,
          400,
          "idempotency_key_required",
          "An Idempotency-Key header is required."
        );
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
        params: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: [
                "support-bundle.create",
                "kill-switch.set",
                "quarantine.resolve",
                "recovery.start",
              ],
            },
          },
        },
        headers: {
          type: "object",
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 500 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["input"],
          properties: { input: { type: "object", additionalProperties: true } },
        },
        response: {
          202: {
            type: "object",
            required: ["commandId", "status"],
            properties: {
              commandId: { type: "string" },
              status: { type: "string", enum: ["accepted", "duplicate"] },
            },
          },
          400: errorSchema,
          403: errorSchema,
          409: errorSchema,
          501: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const grant = await requireGrant(request, reply, deps, "operations:control");
      if (!grant) return;
      const key = idempotencyKey(request);
      if (!key) {
        return fail(
          reply,
          request,
          400,
          "idempotency_key_required",
          "An Idempotency-Key header is required."
        );
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
