/**
 * Putting a File into Knowledge, and taking it out again.
 *
 * Split out of `routes.ts` to keep that file under the repo's size limit, and because these two
 * are the only File routes that reach a second subsystem: everything else here is the File domain
 * talking to itself. They are also the only two that can be absent — a deployment with no indexer
 * wired answers 501 rather than pretending to have accepted.
 */

import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { isExtractableMediaType } from "@tulipfarm/files";
import type { FastifyInstance } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequestPrincipal } from "../identity/principal";
import { type FileRoutesDeps, type PreHandler, reject } from "./routes";

export function registerFileKnowledgeRoutes(
  app: FastifyInstance,
  deps: FileRoutesDeps,
  requireAuth: PreHandler
): void {
  app.post(
    "/api/v1/files/:id/knowledge",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Adds a File to Knowledge, so an Agent can answer from its contents and cite it. " +
          "Only the owner may, and the indexed content is readable by exactly the Principals the " +
          "File itself is — its owner and whoever it is shared with. Uploading never does this: " +
          "making a document retrievable is a different act from attaching it to one Chat. " +
          "Answers 202 because the text is extracted outside this process. A type that carries " +
          "no text at all, an image among them, is refused here with 415; a scan with no text " +
          "layer can only be discovered later, and is accepted and then indexed as nothing.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          202: { type: "null" },
          401: ErrorSchema,
          404: ErrorSchema,
          415: ErrorSchema,
          501: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      const knowledge = deps.knowledge;
      if (!knowledge?.available) {
        reply.code(501).send({ error: "this deployment cannot index Files into Knowledge" });
        return;
      }
      try {
        // Owner-only: `read` refuses a caller who is not the owner or a sharee, and the owner
        // check below refuses the rest, both with the 404 a File that does not exist would answer.
        const file = await deps.files.read(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        // Refused here rather than swallowed by the worker. The type is knowable now, and a 202
        // for a File that can never be indexed would leave the library showing "in knowledge" for
        // something no Agent will ever retrieve — which for an image, the commonest upload in a
        // chat product, would be the ordinary outcome rather than the exception.
        if (!isExtractableMediaType(file.mediaType)) {
          reply.code(415).send({
            error: `${file.mediaType} carries no text to index. Attach it to a chat instead.`,
          });
          return;
        }
        // Recorded before anything is enqueued, so the worker has a durable opt-in to re-read.
        await deps.files.requestKnowledge(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        await knowledge.requestIndex(id, file.currentVersionId, principal.id);
        reply.code(202).send();
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/files/:id/knowledge",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Removes a File from Knowledge. Its chunks and embeddings go with it, so retrieval " +
          "cannot quote the File afterwards. The File itself is untouched. Answers 204 whether " +
          "or not it was indexed.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 204: { type: "null" }, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      try {
        // The opt-in is withdrawn before the Page goes, so an index job still in flight stops
        // rather than re-creating what this call just removed.
        await deps.files.clearKnowledgeRequest(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        await deps.knowledge?.remove(id);
        reply.code(204).send();
      } catch (error) {
        reject(reply, error);
      }
    }
  );
}
