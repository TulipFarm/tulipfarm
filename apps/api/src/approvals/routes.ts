import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { ApprovalRegistry } from "../chat/approvals";
import type { ApprovalsRepo } from "./repo";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Routine-approval extension: DB-backed routine_state rows + run resumption (v0.11). */
export interface RoutineApprovalDeps {
  approvalsRepo: ApprovalsRepo;
  enqueueWake: (job: {
    runId: string;
    reason: "approval";
    token: string;
    decision: "approved" | "denied";
  }) => Promise<void>;
}

/**
 * Standalone approval routes (AGT-V1-002). Serves BOTH approval kinds behind one
 * discriminated list/decide surface: `tool_call` (in-memory registry, ephemeral,
 * resumes a suspended chat stream) and `routine_state` (DB rows, durable, resumes a
 * suspended routine run via a routine-wake job).
 */
export function registerApprovalRoutes(
  app: FastifyInstance,
  approvalRegistry: ApprovalRegistry,
  requireAuth: PreHandler,
  routineDeps?: RoutineApprovalDeps
): void {
  app.get(
    "/api/v1/approvals",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List all pending approvals, both kinds: tool_call (ephemeral, in-memory — empties on " +
          "restart) and routine_state (durable rows for routine human_approval states). " +
          "Discriminate on `kind`.",
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
      const toolCalls = approvalRegistry
        .listPending()
        .map((item) => ({ kind: "tool_call" as const, ...item }));

      let routineItems: Array<Record<string, unknown>> = [];
      if (routineDeps) {
        const rows = await routineDeps.approvalsRepo.listPending("routine_state");
        routineItems = rows.map((row) => {
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
      }
      return reply.send({ items: [...toolCalls, ...routineItems] });
    }
  );

  app.post(
    "/api/v1/approvals/:approvalId/decide",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Approve or deny a pending approval. tool_call: resumes the suspended chat stream with " +
          "the tool result (approve) or an error the model sees (deny). routine_state: settles the " +
          "row and wakes the suspended routine run with the decision.",
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
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      const { decision } = req.body as { decision: "approve" | "deny" };
      const settled = decision === "approve" ? "approved" : "denied";

      // Tool-call approvals first (in-memory authoritative), then DB routine_state rows.
      const resolved = approvalRegistry.decide(approvalId, settled);
      if (resolved) return reply.send({ status: decision });

      if (routineDeps) {
        const row = await routineDeps.approvalsRepo.findById(approvalId);
        if (row && row.kind === "routine_state" && row.status === "pending") {
          const payload = (row.payload ?? {}) as { runId?: string };
          if (payload.runId) {
            await routineDeps.approvalsRepo.settle(approvalId, settled);
            await routineDeps.enqueueWake({
              runId: payload.runId,
              reason: "approval",
              token: `approval:${approvalId}`,
              decision: settled,
            });
            return reply.send({ status: decision });
          }
        }
      }
      return reply.code(404).send({ error: "approval not found or already resolved" });
    }
  );
}
