import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { ApprovalRegistry } from "../chat/approvals";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Standalone approval routes (AGT-V1-002). Shared by tool-call approvals (current)
 * and future routine human_approval states (v0.11).
 */
export function registerApprovalRoutes(
  app: FastifyInstance,
  approvalRegistry: ApprovalRegistry,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/approvals",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List all in-flight (pending) tool-execution approvals. Single-trust V1: not scoped " +
          "per-user. Ephemeral — the set empties on API restart. Poll to drive the Approvals view + badge.",
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
                  required: ["approvalId", "toolCallId", "toolName", "expiresAt", "createdAt"],
                  properties: {
                    approvalId: { type: "string" },
                    toolCallId: { type: "string" },
                    toolName: { type: "string" },
                    args: {},
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
      return reply.send({ items: approvalRegistry.listPending() });
    }
  );

  app.post(
    "/api/v1/approvals/:approvalId/decide",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Approve or deny a pending tool-execution approval. Resumes the suspended chat stream " +
          "with the tool result (approve) or an error result the model sees (deny).",
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
      const resolved = approvalRegistry.decide(
        approvalId,
        decision === "approve" ? "approved" : "denied"
      );
      if (!resolved) {
        return reply.code(404).send({ error: "approval not found or already resolved" });
      }
      return reply.send({ status: decision });
    }
  );
}
