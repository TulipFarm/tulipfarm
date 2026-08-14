/** Admin-only audit ledger reader; events can name principals and safeMetadata evidence. */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { type AuditReadService, AuditTooLargeError } from "./read-service";
import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX } from "./repo";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const AuditEventSchema = {
  type: "object",
  required: ["id", "chainIndex", "hash", "action", "target", "decision", "occurredAt"],
  properties: {
    id: { type: "string" },
    chainIndex: { type: "integer" },
    previousHash: { type: "string", nullable: true },
    hash: { type: "string" },
    actorPrincipalId: { type: "string" },
    effectivePrincipalId: { type: "string" },
    action: { type: "string" },
    target: { type: "string" },
    decision: { type: "string" },
    reasonCodes: { type: "array", items: { type: "string" } },
    correlationId: { type: "string" },
    occurredAt: { type: "string" },
    agentId: { type: "string", nullable: true },
    runId: { type: "string", nullable: true },
    safeMetadata: { type: "object", additionalProperties: true, nullable: true },
  },
} as const;

const AuditPageSchema = {
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: AuditEventSchema },
    nextCursor: { type: "integer", nullable: true },
  },
} as const;

const AuditVerifySchema = {
  type: "object",
  required: ["valid", "eventCount", "issues", "tailHash", "checkedAt"],
  properties: {
    valid: { type: "boolean" },
    eventCount: { type: "integer" },
    tailHash: { type: "string", nullable: true },
    checkedAt: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "chainIndex", "eventIds"],
        properties: {
          type: { type: "string" },
          chainIndex: { type: "integer" },
          eventIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** Flattens the principal refs, whose `businessId` is the same deployment value on every row. */
function toWire(event: {
  id: string;
  chainIndex: number;
  previousHash: string | null;
  hash: string;
  actor: { principalId: string };
  effectivePrincipal: { principalId: string };
  action: string;
  target: string;
  decision: string;
  reasonCodes: readonly string[];
  correlationId: string;
  occurredAt: Date;
  agentId?: string;
  runId?: string;
  safeMetadata?: Record<string, unknown>;
}) {
  return {
    id: event.id,
    chainIndex: event.chainIndex,
    previousHash: event.previousHash,
    hash: event.hash,
    actorPrincipalId: event.actor.principalId,
    effectivePrincipalId: event.effectivePrincipal.principalId,
    action: event.action,
    target: event.target,
    decision: event.decision,
    reasonCodes: [...event.reasonCodes],
    correlationId: event.correlationId,
    occurredAt: event.occurredAt.toISOString(),
    agentId: event.agentId ?? null,
    runId: event.runId ?? null,
    safeMetadata: event.safeMetadata ?? null,
  };
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if ((req.user as UserDoc | undefined)?.role !== "admin") {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

export function registerAuditRoutes(
  app: FastifyInstance,
  service: AuditReadService,
  requireAuth: PreHandler
): void {
  app.get<{
    Querystring: {
      limit?: number;
      cursor?: number;
      action?: string;
      actorId?: string;
      decision?: string;
    };
  }>(
    "/api/v1/audit/events",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Read the audit ledger, newest first (admin only). Cursor is the chainIndex of the " +
          "last row on the previous page.",
        tags: ["audit"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: AUDIT_PAGE_MAX,
              default: AUDIT_PAGE_DEFAULT,
            },
            cursor: { type: "integer", minimum: 0 },
            action: { type: "string" },
            actorId: { type: "string" },
            decision: { type: "string", enum: ["allow", "deny"] },
          },
        },
        response: { 200: AuditPageSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      const page = await service.list({
        ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
        ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
        ...(req.query.action ? { action: req.query.action } : {}),
        ...(req.query.actorId ? { actorId: req.query.actorId } : {}),
        ...(req.query.decision ? { decision: req.query.decision } : {}),
      });
      return reply.send({ items: page.items.map(toWire), nextCursor: page.nextCursor });
    }
  );

  app.get<{ Querystring: { eventCount?: number; tailHash?: string } }>(
    "/api/v1/audit/verify",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Re-derive the audit hash chain and report tampering, gaps, forks or reordering " +
          "(admin only). Supply eventCount/tailHash from a previously recorded verification to " +
          "also detect deletion of the chain's tail.",
        tags: ["audit"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            eventCount: { type: "integer", minimum: 0 },
            tailHash: { type: "string" },
          },
        },
        response: {
          200: AuditVerifySchema,
          401: ErrorSchema,
          403: ErrorSchema,
          413: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      try {
        const report = await service.verify({
          ...(req.query.eventCount !== undefined ? { eventCount: req.query.eventCount } : {}),
          ...(req.query.tailHash !== undefined ? { tailHash: req.query.tailHash } : {}),
        });
        return reply.send({ ...report, issues: report.issues.map((i) => ({ ...i })) });
      } catch (error) {
        if (error instanceof AuditTooLargeError) {
          return reply.code(413).send({ error: error.message });
        }
        throw error;
      }
    }
  );
}
