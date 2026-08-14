import type { KillSwitchRecord } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { AUTHZ_SECURITY } from "../authz/schemas";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";
import {
  type EnableKillSwitchRequest,
  type KillSwitchActor,
  KillSwitchError,
  type KillSwitchErrorCode,
  type KillSwitchService,
} from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const KILL_SWITCH_WRITE_LIMIT = 30;
const KILL_SWITCH_WRITE_WINDOW_MS = 60_000;

const KillSwitchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "scopeKind", "reasonCode", "enabledAt", "enabledBy", "enabled"],
  properties: {
    id: { type: "string" },
    scopeKind: { type: "string" },
    scopeValue: { type: "string" },
    reasonCode: { type: "string" },
    enabledAt: { type: "string", format: "date-time" },
    enabledBy: { type: "string" },
    enabled: { type: "boolean" },
    disabledAt: { type: "string", format: "date-time" },
    disabledBy: { type: "string" },
  },
} as const;

/** Fail closed: API clients have no role, and only signed-in admin users pass. */
const requireDeploymentAdmin: PreHandler = async (req, reply) => {
  if (!req.principal) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }
  if (req.principal.kind !== "user" || req.principal.role !== "admin") {
    await reply.code(403).send({ error: "forbidden" });
  }
};

const ERROR_STATUS: Readonly<Record<KillSwitchErrorCode, 404 | 409 | 422>> = {
  not_found: 404,
  // 409: the switch exists and the request is well-formed; it just lost the race to another
  // operator who already stood it down.
  already_disabled: 409,
  invalid_scope: 422,
  unenforceable_scope: 422,
};

function view(record: KillSwitchRecord) {
  return {
    id: record.id,
    scopeKind: record.scope.kind,
    ...(record.scope.value === undefined ? {} : { scopeValue: record.scope.value }),
    reasonCode: record.reasonCode,
    enabledAt: record.enabledAt,
    enabledBy: record.enabledBy,
    enabled: record.disabledAt === undefined,
    ...(record.disabledAt === undefined ? {} : { disabledAt: record.disabledAt }),
    ...(record.disabledBy === undefined ? {} : { disabledBy: record.disabledBy }),
  };
}

function actorFrom(req: FastifyRequest): KillSwitchActor {
  return { principalId: req.principal?.id ?? "unknown", correlationId: req.id };
}

async function send(
  reply: FastifyReply,
  code: 200 | 201,
  operation: () => Promise<KillSwitchRecord>
): Promise<FastifyReply> {
  try {
    return await reply.code(code).send({ killSwitch: view(await operation()) });
  } catch (error) {
    if (error instanceof KillSwitchError) {
      return reply.code(ERROR_STATUS[error.code]).send({ error: error.message });
    }
    throw error;
  }
}

export function registerKillSwitchRoutes(
  app: FastifyInstance,
  service: KillSwitchService,
  requireAuth: PreHandler,
  rateLimiter?: RateLimiter
): void {
  const rateLimitHook = rateLimiter
    ? makeRateLimitHook(
        rateLimiter,
        (req) => `rl:kill-switch:${req.ip}`,
        KILL_SWITCH_WRITE_LIMIT,
        KILL_SWITCH_WRITE_WINDOW_MS
      )
    : undefined;
  const gate: PreHandler[] = rateLimitHook
    ? [rateLimitHook, requireAuth, requireDeploymentAdmin]
    : [requireAuth, requireDeploymentAdmin];

  app.get(
    "/api/v1/kill-switches",
    {
      preHandler: gate,
      schema: {
        description:
          "List every mutation kill switch, live and stood down, newest first, plus the scope " +
          "kinds a guard can currently enforce.",
        tags: ["kill-switches"],
        security: AUTHZ_SECURITY,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["killSwitches", "enforceableScopeKinds"],
            properties: {
              killSwitches: { type: "array", items: KillSwitchSchema },
              enforceableScopeKinds: { type: "array", items: { type: "string" } },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async () => ({
      killSwitches: (await service.list()).map(view),
      enforceableScopeKinds: service.enforceableScopeKinds(),
    })
  );

  app.post(
    "/api/v1/kill-switches",
    {
      preHandler: gate,
      schema: {
        description:
          "Arm a kill switch. Mutating Tool effects matching the scope are denied from the next " +
          "dispatch onward; reads are never affected.",
        tags: ["kill-switches"],
        security: AUTHZ_SECURITY,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["scopeKind", "reasonCode"],
          properties: {
            scopeKind: { type: "string", minLength: 1 },
            scopeValue: { type: "string", minLength: 1 },
            reasonCode: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        response: {
          201: {
            type: "object",
            additionalProperties: false,
            required: ["killSwitch"],
            properties: { killSwitch: KillSwitchSchema },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          422: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { scopeKind: string; scopeValue?: string; reasonCode: string };
      const request = {
        scope: {
          kind: body.scopeKind,
          ...(body.scopeValue === undefined ? {} : { value: body.scopeValue }),
        },
        reasonCode: body.reasonCode,
      } as EnableKillSwitchRequest;
      return send(reply, 201, () => service.enable(request, actorFrom(req)));
    }
  );

  app.delete(
    "/api/v1/kill-switches/:id",
    {
      preHandler: gate,
      schema: {
        description:
          "Stand a kill switch down. The row is kept with who stood it down and when, because " +
          "whether a stop was live at a given instant is incident evidence.",
        tags: ["kill-switches"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["killSwitch"],
            properties: { killSwitch: KillSwitchSchema },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return send(reply, 200, () => service.disable(id, actorFrom(req)));
    }
  );
}
