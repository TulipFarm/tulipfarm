import { Type } from "@sinclair/typebox";
import { McpKnowledgeError } from "@tulipfarm/knowledge";
import {
  McpKnowledgeCheckpointSchema,
  type McpKnowledgePut,
  McpKnowledgePutSchema,
  McpKnowledgeStatusSchema,
  McpKnowledgeVersionSchema,
} from "@tulipfarm/schema";
import { McpKnowledgeFenceError } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { RequireAuthorization } from "../../authz/route-gate";
import type { McpKnowledgeFeature } from "./compose";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type Params = { key: string; accountId: string };
const params = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 128 }),
    accountId: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);
const security: Record<string, string[]>[] = [{ sessionCookie: [] }, { bearerToken: [] }];
const common = {
  tags: ["Integrations"],
  security,
  params,
  response: {
    200: McpKnowledgeStatusSchema,
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
    409: ErrorSchema,
    422: ErrorSchema,
    503: ErrorSchema,
  },
};

export function registerMcpKnowledgeRoutes(
  app: FastifyInstance,
  deps: {
    readonly knowledge: McpKnowledgeFeature;
    readonly readerUserId: (request: FastifyRequest) => Promise<string>;
  },
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const read = [
    requireAuth,
    requireAuthorization({
      action: "integration.read",
      resourceType: "integration",
      fallback: "authenticated",
    }),
  ];
  const manage = [
    requireAuth,
    requireAuthorization({
      action: "integration.accounts.write",
      resourceType: "integration",
      fallback: "authenticated",
    }),
  ];
  const path = "/api/v1/integrations/:key/accounts/:accountId/knowledge";
  async function respond(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (userId: string) => Promise<unknown>
  ) {
    try {
      return await work(await deps.readerUserId(request));
    } catch (error) {
      if (error instanceof McpKnowledgeFenceError)
        return reply.code(409).send({
          error: "knowledge_selection_changed",
          message: "Reload the Knowledge selection and try again.",
        });
      if (error instanceof McpKnowledgeError) {
        return reply.code(error.code === "identity_mismatch" ? 403 : 422).send({
          error: error.code,
          message: "This selected source or account is not available for Knowledge sync.",
        });
      }
      return reply.code(503).send({
        error: "knowledge_unavailable",
        message: "Knowledge sync is temporarily unavailable.",
      });
    }
  }
  app.get<{ Params: Params }>(
    path,
    {
      preHandler: read,
      schema: {
        ...common,
        description: "Read exact-account Knowledge eligibility, selection and durable progress.",
      },
    },
    async (request, reply) =>
      respond(request, reply, (userId) =>
        deps.knowledge.status(request.params.key, request.params.accountId, userId)
      )
  );
  app.put<{ Params: Params; Body: McpKnowledgePut }>(
    path,
    {
      preHandler: manage,
      schema: {
        ...common,
        body: McpKnowledgePutSchema,
        description: "Select explicit private GitHub branch files for read-only Knowledge sync.",
      },
    },
    async (request, reply) =>
      respond(request, reply, (userId) =>
        deps.knowledge.put(request.params.key, request.params.accountId, userId, request.body)
      )
  );
  app.post<{ Params: Params; Body: { expectedRevision: number } }>(
    `${path}/sync`,
    {
      preHandler: manage,
      schema: {
        ...common,
        body: McpKnowledgeVersionSchema,
        description:
          "Request a fresh bounded sync without losing a newer request to an older leased job.",
      },
    },
    async (request, reply) =>
      respond(request, reply, (userId) =>
        deps.knowledge.change(
          request.params.key,
          request.params.accountId,
          userId,
          request.body.expectedRevision,
          false
        )
      )
  );
  app.delete<{ Params: Params; Body: { expectedRevision: number } }>(
    path,
    {
      preHandler: manage,
      schema: {
        ...common,
        body: McpKnowledgeVersionSchema,
        description:
          "Disable selected Knowledge immediately and durably schedule copied-content erasure.",
      },
    },
    async (request, reply) =>
      respond(request, reply, (userId) =>
        deps.knowledge.change(
          request.params.key,
          request.params.accountId,
          userId,
          request.body.expectedRevision,
          true
        )
      )
  );
  app.get<{ Params: { pageId: string } }>(
    "/api/v1/knowledge/pages/:pageId/source",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.accounts.read",
          resourceType: "integration",
          fallback: "authenticated",
        }),
      ],
      schema: {
        tags: ["Knowledge"],
        description:
          "Read source attribution and stale-data status only after a fresh exact-viewer MCP permission read.",
        security: common.security,
        params: Type.Object({ pageId: Type.String({ format: "uuid" }) }),
        response: {
          200: Type.Object({
            readOnly: Type.Literal(true),
            sourceUrl: Type.String(),
            lastSyncedAt: Type.String({ format: "date-time" }),
            stale: Type.Boolean(),
          }),
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = await deps.readerUserId(request);
      const metadata = await deps.knowledge.pageMetadata(userId, request.params.pageId);
      if (!metadata)
        return reply.code(404).send({ error: "not_found", message: "Source is not available." });
      return metadata;
    }
  );
}

/** Returns a live, lineage-validated user only when the Run audience permits personal source access. */
export type McpKnowledgeRunReaderResolver = (runId: string) => Promise<string | undefined>;

export function registerMcpKnowledgeWorkerRoutes(
  app: FastifyInstance,
  knowledge: Pick<McpKnowledgeFeature, "canReadPageForRun" | "reconcile" | "batch">,
  requireWorker: PreHandler,
  resolveReader: McpKnowledgeRunReaderResolver
): void {
  app.post<{ Body: { runId: string; readerUserId: string; pageId: string } }>(
    "/api/v1/internal/mcp-knowledge/page-access",
    {
      preHandler: [requireWorker],
      schema: {
        tags: ["Internal"],
        description:
          "Recheck source access for the actual user of a currently running Run; never borrow a source owner's account.",
        security: [{ bearerToken: [] }],
        body: Type.Object(
          {
            runId: Type.String({ format: "uuid" }),
            readerUserId: Type.String({ minLength: 1, maxLength: 256 }),
            pageId: Type.String({ format: "uuid" }),
          },
          { additionalProperties: false }
        ),
        response: {
          200: Type.Object({ allowed: Type.Boolean() }),
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { runId, readerUserId, pageId } = request.body;
        if ((await resolveReader(runId)) !== readerUserId) return { allowed: false };
        const allowed = await knowledge.canReadPageForRun(runId, readerUserId, pageId);
        return {
          allowed: allowed && (await resolveReader(runId)) === readerUserId,
        };
      } catch {
        return reply.code(503).send({
          error: "knowledge_access_unavailable",
          message: "Fresh source access is unavailable.",
        });
      }
    }
  );
  app.post(
    "/api/v1/internal/mcp-knowledge/reconcile",
    {
      preHandler: [requireWorker],
      schema: {
        tags: ["Internal"],
        description:
          "Reconcile confirmed account lifecycle changes and retry pending Knowledge erasure.",
        security: [{ bearerToken: [] }],
        body: Type.Object({}, { additionalProperties: false }),
        response: {
          200: Type.Object({ cleaned: Type.Integer({ minimum: 0 }) }),
          401: ErrorSchema,
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        return { cleaned: await knowledge.reconcile() };
      } catch {
        return reply
          .code(503)
          .send({ error: "knowledge_sync_unavailable", message: "Knowledge sync will retry." });
      }
    }
  );
  app.post<{
    Body: {
      accountId: string;
      selectionId: string;
      selectionRevision: string;
      leaseId: string;
    };
  }>(
    "/api/v1/internal/mcp-knowledge/batch",
    {
      preHandler: [requireWorker],
      schema: {
        tags: ["Internal"],
        description:
          "Execute one already-leased worker batch with scoped MCP reads and fenced Knowledge publication.",
        security: [{ bearerToken: [] }],
        body: Type.Object(
          {
            accountId: Type.String({ minLength: 1, maxLength: 256 }),
            selectionId: Type.String({ minLength: 1, maxLength: 256 }),
            selectionRevision: Type.String({ pattern: "^[1-9][0-9]*$" }),
            leaseId: Type.String({ format: "uuid" }),
          },
          { additionalProperties: false }
        ),
        response: {
          200: McpKnowledgeCheckpointSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await knowledge.batch(request.body);
      } catch (error) {
        if (error instanceof McpKnowledgeFenceError)
          return reply.code(409).send({
            error: "knowledge_lease_changed",
            message: "Knowledge job authority changed.",
          });
        return reply.code(503).send({
          error: "knowledge_sync_unavailable",
          message: "Knowledge sync will retry.",
        });
      }
    }
  );
}
