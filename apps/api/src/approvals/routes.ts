import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { listPendingToolApprovals } from "./pending";
import type { RoutineApprovalService } from "./routine-approvals";
import type { ApprovalsRepo } from "./runtime-repo";
import type { ToolApprovalService } from "./tool-approvals";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Deps for the one discriminated approval surface: `tool_call` and `routine_state` rows. */
export interface ApprovalRoutesDeps {
  /** The authority for both kinds. Pending state is read from here, never from this process. */
  readonly approvals: ApprovalsRepo;
  /** Settles a `tool_call` approval and resumes the Run parked on it. */
  readonly toolApprovals?: ToolApprovalService;
  /** Settles a `routine_state` approval a Worker-executed Routine parked on. */
  readonly routineApprovals?: RoutineApprovalService;
}

/**
 * Standalone approval routes. Serves BOTH approval kinds behind one
 * discriminated list/decide surface. Both kinds are PostgreSQL-authoritative.
 */
export function registerApprovalRoutes(
  app: FastifyInstance,
  deps: ApprovalRoutesDeps,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/approvals",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List all durable pending approvals. Discriminate tool_call and routine_state by kind.",
        tags: ["approvals"],
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
                  required: ["approvalId", "kind", "expiresAt", "createdAt"],
                  properties: {
                    approvalId: { type: "string" },
                    kind: { type: "string", enum: ["tool_call", "routine_state"] },
                    // tool_call fields
                    toolCallId: { type: "string" },
                    toolName: { type: "string" },
                    args: {},
                    // routine_state fields
                    routineSlug: { type: "string" },
                    runId: { type: "string" },
                    stateName: { type: "string" },
                    summary: {},
                    expiresAt: { type: "string" },
                    createdAt: { type: "string" },
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
      const [pendingToolCalls, routineRows] = await Promise.all([
        listPendingToolApprovals(deps.approvals),
        deps.approvals.listPending("routine_state"),
      ]);
      const toolCalls = pendingToolCalls.map((item) => ({ kind: "tool_call" as const, ...item }));
      const routineItems = routineRows.map((row) => {
        const payload = (row.payload ?? {}) as {
          routineSlug?: string;
          runId?: string;
          stateName?: string;
          summary?: unknown;
        };
        return {
          kind: "routine_state" as const,
          approvalId: row.id,
          routineSlug: payload.routineSlug,
          runId: payload.runId,
          stateName: payload.stateName,
          summary: payload.summary,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        };
      });
      return reply.send({ items: [...toolCalls, ...routineItems] });
    }
  );

  app.post(
    "/api/v1/approvals/:approvalId/decide",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Approve or deny a pending approval. tool_call: settles the row and resumes the same Run " +
          "the turn parked on, wherever it is executing. routine_state: settles the row and wakes " +
          "the suspended routine run with the decision.",
        tags: ["approvals"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["approvalId"],
          properties: { approvalId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["decision"],
          additionalProperties: false,
          properties: { decision: { type: "string", enum: ["approve", "deny"] } },
        },
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      const { decision } = req.body as { decision: "approve" | "deny" };
      const settled = decision === "approve" ? "approved" : "denied";

      // A turn parks on a durable wait, so its decision is a kernel signal that requeues the same
      // Run — nothing in this process is holding the call. `not_found` falls through: the row may be
      // a `routine_state` approval, which the branch below owns.
      if (deps.toolApprovals && req.principal) {
        const outcome = await deps.toolApprovals.signal({
          businessId: DEPLOYMENT_BUSINESS_ID,
          approvalId,
          decision: settled,
          principal: `${req.principal.kind}:${req.principal.id}`,
        });
        if (outcome === "resumed") return reply.send({ status: decision });
        if (outcome === "forbidden") {
          return reply.code(403).send({ error: "this approval is not yours to decide" });
        }
        if (outcome === "already_settled") {
          return reply.code(404).send({ error: "approval not found or already resolved" });
        }
      }

      // A Routine State parks the same way, but names roles rather than a person: authority comes
      // from the roles this principal holds against the ones the State authored.
      if (deps.routineApprovals && req.principal) {
        const outcome = await deps.routineApprovals.signal({
          businessId: DEPLOYMENT_BUSINESS_ID,
          approvalId,
          decision: settled,
          principal: `${req.principal.kind}:${req.principal.id}`,
          roles: req.principal.role ? [req.principal.role] : [],
        });
        if (outcome === "resumed") return reply.send({ status: decision });
        if (outcome === "forbidden") {
          return reply.code(403).send({ error: "this approval is not yours to decide" });
        }
        if (outcome === "already_settled") {
          return reply.code(404).send({ error: "approval not found or already resolved" });
        }
      }

      return reply.code(404).send({ error: "approval not found or already resolved" });
    }
  );
}
