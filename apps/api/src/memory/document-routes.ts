import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { MEMORY_DOCUMENT_CHAR_BUDGET, type MemoryDocumentRepo } from "@tulipfarm/memory";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * The caller's own Memory Document, read-only.
 *
 * Read-only is the whole contract, not a limitation waiting to be lifted. Memory is what the
 * system concluded, and an editable copy would make it a second set of Custom instructions with
 * none of that field's guarantees. Someone who disagrees with a line says so in chat, which is
 * the path that leaves a revision and a writer behind it.
 *
 * A user with no document yet gets an empty page rather than a 404: nothing has been concluded
 * about them, which is a state worth showing.
 */
export function registerMemoryDocumentRoute(
  app: FastifyInstance,
  documents: MemoryDocumentRepo,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/memory/document",
    {
      preHandler: requireAuth,
      schema: {
        description: "Read the current user's Memory Document as Markdown. Never writable.",
        tags: ["memory"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["document", "characters", "characterBudget"],
            properties: {
              document: { type: "string" },
              characters: { type: "number" },
              characterBudget: { type: "number" },
              updatedAt: { type: "string" },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = (req.user as UserDoc)._id;
      const record = await documents.read(DEPLOYMENT_BUSINESS_ID, userId);
      const document = record?.document ?? "";
      return reply.send({
        document,
        characters: document.length,
        characterBudget: MEMORY_DOCUMENT_CHAR_BUDGET,
        ...(record ? { updatedAt: record.updatedAt.toISOString() } : {}),
      });
    }
  );
}
