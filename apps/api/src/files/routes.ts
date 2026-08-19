/**
 * The Files HTTP surface.
 *
 * Everything about *what* an upload is allowed to be lives in `@tulipfarm/files`; this module is
 * only the Fastify adaptation of it — reading the request as a stream, turning a `FileError` into
 * a status, and setting the response headers that make a download safe.
 *
 * Uploads are a single object in the request body, with the claimed type in `Content-Type` and the
 * name in a query parameter. There is no multipart envelope: parsing one would mean buffering the
 * part header before the declared length could be checked, which inverts the ordered pipeline the
 * whole design rests on.
 */

import { Readable } from "node:stream";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ALLOWED_MEDIA_TYPES,
  decodeFileCursor,
  downloadHeaders,
  FILE_GRANTEE_KINDS,
  FILE_GRANTEE_SCHEMA,
  FILE_PAGE_QUERY_SCHEMA,
  FILE_PAGE_SCHEMA,
  FILE_SHARES_SCHEMA,
  FILE_WIRE_SCHEMA,
  type FileCursor,
  type FileGrantee,
  type FileGranteeKind,
  type FileRecord,
  type FileService,
  fileErrorStatus,
  isExtractableMediaType,
  serializeFile,
  serializeFilePage,
  serializeShare,
} from "@tulipfarm/files";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditRecordInput } from "../audit/service";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import type { RequestPrincipal } from "../identity/principal";
import type { FileKnowledgeBridge } from "./knowledge-bridge";
import { registerFileKnowledgeRoutes } from "./knowledge-routes";

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface FileRoutesDeps {
  readonly files: FileService;
  /**
   * Where a destruction is recorded. Optional only because a deployment can run without an audit
   * chain at all; when one exists, a File that stops existing has to leave evidence behind it.
   */
  readonly audit?: { recordOrWarn(input: AuditRecordInput): Promise<void> };
  /**
   * The input modalities some configured model accepts, so the composer can refuse a file before
   * someone writes a prompt around it. A function because the Soul is reloadable.
   */
  readonly acceptedInputModalities: () => readonly string[];
  /**
   * The Knowledge side of a File. Absent leaves the routes below answering 501 rather than
   * pretending: a deployment with no bridge cannot index, and saying so is better than accepting
   * a request nothing will ever act on.
   */
  readonly knowledge?: FileKnowledgeBridge;
}

/** The two Files listings differ only in which set they draw from, so they page identically. */
async function sendPage(
  req: FastifyRequest,
  reply: FastifyReply,
  page: (
    principalId: string,
    limit: number,
    cursor?: FileCursor
  ) => Promise<{
    files: readonly FileRecord[];
    nextCursor: string | null;
    shareCounts?: Map<string, number>;
  }>,
  knowledge?: FileKnowledgeBridge
): Promise<void> {
  const { limit = 50, after } = req.query as { limit?: number; after?: string };
  const cursor = after === undefined ? undefined : decodeFileCursor(after);
  if (cursor === null) {
    reply.code(400).send({ error: "that cursor is not one of ours" });
    return;
  }
  const result = await page((req.principal as RequestPrincipal).id, limit, cursor);
  // Asked only for a listing that already carries share counts, which is the owner's listing.
  // Whether a File is in Knowledge is the owner's business for the same reason its share count is.
  const knowledgeIds =
    knowledge && result.shareCounts
      ? await knowledge.indexedIds(result.files.map((file) => file.id))
      : undefined;
  reply.send(
    serializeFilePage({ ...result, ...(knowledgeIds === undefined ? {} : { knowledgeIds }) })
  );
}

/**
 * Re-point an indexed File's Page at its current readers.
 *
 * Called after every share and every revoke. An authored Page's ACL is read live on each question,
 * so this write *is* the propagation — there is no cache to invalidate and no snapshot to age out.
 * A File that is not indexed has no Page and this is a no-op.
 */
async function syncKnowledgeReaders(
  deps: FileRoutesDeps,
  fileId: string,
  ownerPrincipalId: string,
  widening: boolean
): Promise<void> {
  const knowledge = deps.knowledge;
  if (!knowledge) return;
  if (!(await knowledge.isIndexed(fileId))) return;
  try {
    const readers = await deps.files.readers(DEPLOYMENT_BUSINESS_ID, fileId, ownerPrincipalId);
    await knowledge.syncReaders(fileId, readers);
  } catch (error) {
    // A share that failed to propagate is safe to surface and leave: the new reader simply cannot
    // retrieve the File yet. A *revoke* is not. The File-level grant is already gone, so failing
    // here would leave the revoked reader able to retrieve the text through Knowledge while the
    // owner is looking at an error that suggests nothing happened. So the Page goes instead — the
    // File stops being retrievable by anyone, which is always a subset of what was intended.
    if (!widening) await knowledge.remove(fileId);
    throw error;
  }
}

export function reject(reply: FastifyReply, error: unknown): void {
  const status = fileErrorStatus(error);
  if (status === null) throw error;
  reply.code(status).send({ error: (error as Error).message });
}

export function registerFileRoutes(
  app: FastifyInstance,
  deps: FileRoutesDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  registerFileKnowledgeRoutes(app, deps, requireAuth);

  // Scoped to a plugin so the raw-stream parsers cannot change how any other route reads a body.
  app.register(async (scope) => {
    for (const mediaType of [...ALLOWED_MEDIA_TYPES, "application/octet-stream"]) {
      scope.addContentTypeParser(mediaType, (_req, payload, done) => {
        done(null, payload);
      });
    }
    // A claimed type outside the allowlist still has to reach the handler, so the caller learns
    // that the type was refused rather than getting Fastify's bare unsupported-media-type error.
    scope.addContentTypeParser("*", (_req, payload, done) => {
      done(null, payload);
    });

    scope.post(
      "/api/v1/files",
      {
        preHandler: [
          requireAuth,
          requireAuthorization({
            action: "file.create",
            resourceType: "file",
            fallback: "authenticated",
          }),
        ],
        schema: {
          description:
            "Uploads one File. The body is the object itself and `Content-Type` is the claimed " +
            "media type; both are treated as untrusted, and the stored type is sniffed from the " +
            "bytes. The File is owned by the calling Principal and is private to it.",
          tags: ["files"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          querystring: {
            type: "object",
            required: ["filename"],
            properties: { filename: { type: "string", minLength: 1 } },
          },
          response: {
            201: FILE_WIRE_SCHEMA,
            400: ErrorSchema,
            401: ErrorSchema,
            403: ErrorSchema,
            413: ErrorSchema,
            415: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const principal = req.principal as RequestPrincipal;
        const { filename } = req.query as { filename: string };
        const declared = Number(req.headers["content-length"] ?? 0);
        const claimed = (req.headers["content-type"] ?? "application/octet-stream")
          .split(";")[0]
          .trim();

        try {
          const file = await deps.files.upload({
            businessId: DEPLOYMENT_BUSINESS_ID,
            ownerPrincipalId: principal.id,
            filename,
            claimedMediaType: claimed,
            declaredBytes: Number.isFinite(declared) ? declared : 0,
            body: req.body as AsyncIterable<Uint8Array>,
          });
          reply.code(201).send(serializeFile(file));
        } catch (error) {
          reject(reply, error);
        }
      }
    );
  });

  app.get(
    "/api/v1/files/accepted-modalities",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "The input modalities some configured model accepts. The composer uses this to refuse " +
          "an attachment nothing could read, before a prompt is written around it. Advisory " +
          "only: routing performs the authoritative check, so absence here is the sole signal " +
          "worth acting on.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["acceptedInputModalities"],
            properties: {
              acceptedInputModalities: { type: "array", items: { type: "string" } },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      reply.send({ acceptedInputModalities: deps.acceptedInputModalities() });
    }
  );

  app.get(
    "/api/v1/files",
    {
      preHandler: requireAuth,
      schema: {
        description: "The Files owned by the calling Principal, newest first.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: FILE_PAGE_QUERY_SCHEMA,
        response: {
          200: FILE_PAGE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) =>
      await sendPage(
        req,
        reply,
        (id, limit, cursor) => deps.files.listPage(DEPLOYMENT_BUSINESS_ID, id, limit, cursor),
        deps.knowledge
      )
  );

  app.get(
    "/api/v1/files/shared-with-me",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "The Files another Principal has shared with the caller, newest first. Files the " +
          "caller owns are left out — those are already on `GET /api/v1/files`. A Role share is " +
          "resolved against the Roles the caller holds right now, so losing a Role removes its " +
          "Files from this list on the very next request.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: FILE_PAGE_QUERY_SCHEMA,
        response: {
          200: FILE_PAGE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) =>
      await sendPage(req, reply, (id, limit, cursor) =>
        deps.files.listSharedWithMe(DEPLOYMENT_BUSINESS_ID, id, limit, cursor)
      )
  );

  app.get(
    "/api/v1/files/:id/shares",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Who a File is shared with. Only its owner may ask: a recipient cannot enumerate the " +
          "other recipients, and a stranger gets the same 404 a missing File gives.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: FILE_SHARES_SCHEMA, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      try {
        const shares = await deps.files.shares(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        reply.send({ shares: shares.map(serializeShare) });
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/files/:id/shares",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Grants one other Principal, or everyone holding one Role, read access to a File. " +
          "Only the owner may share, and sharing conveys reading alone — a recipient can neither " +
          "re-share nor revoke. Repeating a share is a no-op rather than an error.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: FILE_GRANTEE_SCHEMA,
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      try {
        await deps.files.share(DEPLOYMENT_BUSINESS_ID, id, principal.id, req.body as FileGrantee);
        await syncKnowledgeReaders(deps, id, principal.id, true);
        reply.code(204).send();
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/files/:id/shares/:kind/:granteeId",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Revokes one share. The next read by that recipient fails, with no grace period and " +
          "no cached decision to wait out. Answers 204 whether or not a share existed, so this " +
          "route cannot be used to discover who a File was shared with.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id", "kind", "granteeId"],
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: [...FILE_GRANTEE_KINDS] },
            granteeId: { type: "string", minLength: 1 },
          },
        },
        response: { 204: { type: "null" }, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id, kind, granteeId } = req.params as {
        id: string;
        kind: FileGranteeKind;
        granteeId: string;
      };
      try {
        await deps.files.unshare(DEPLOYMENT_BUSINESS_ID, id, principal.id, {
          kind,
          id: granteeId,
        });
        await syncKnowledgeReaders(deps, id, principal.id, false);
        reply.code(204).send();
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/files/:id",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Destroys one File: the row, every share of it, and the bytes. Permanent and " +
          "unrecoverable — there is no soft delete and no object versioning behind it. Only the " +
          "owner may; a File shared with the caller answers exactly as one that does not exist.",
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
        // Authorized first, so a caller who does not own this File is told it does not exist
        // before anything is touched. `clearKnowledgeRequest` refuses a non-owner exactly as
        // `delete` would, and withdraws the opt-in so an index job in flight cannot outlive the
        // File it was reading.
        await deps.files.clearKnowledgeRequest(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        // Un-indexed *before* the File is destroyed, never after. Reversed, a failure between the
        // two leaves a Page whose File no longer exists: retrieval would go on quoting a deleted
        // File, and nothing could ever clean it up, because a second DELETE now answers 404. This
        // way a failure leaves a File that exists and is merely no longer indexed, which the owner
        // can retry or re-add.
        await deps.knowledge?.remove(id);
        const destroyed = await deps.files.delete(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        // Recorded from the returned record rather than the id alone. The chain is sealed and
        // cannot be rewritten later, and by the time anyone reads this event there is nothing
        // left to look the id up against — so what the File *was* has to be captured here.
        await deps.audit?.recordOrWarn({
          actorId: principal.id,
          action: "file.deleted",
          target: `file:${id}`,
          safeMetadata: {
            filename: destroyed.filename,
            mediaType: destroyed.mediaType,
            sizeBytes: destroyed.sizeBytes,
            blobHash: destroyed.blob.hash,
            origin: destroyed.origin,
          },
        });
        reply.code(204).send();
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/files/:id",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "One File's metadata. A File the caller does not own answers exactly as a File that " +
          "does not exist, so this route cannot be used to test whether an id is real.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: FILE_WIRE_SCHEMA, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      try {
        const file = await deps.files.read(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        // Whether the File is in Knowledge is the owner's own decision to see, the same as its
        // share count, so a reader is told nothing rather than told `false`.
        const owned = file.ownerPrincipalId === principal.id;
        const inKnowledge =
          deps.knowledge && owned ? await deps.knowledge.isIndexed(id) : undefined;
        reply.send(serializeFile(file, undefined, inKnowledge));
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/files/:id/content",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "The File's bytes, served with the sniffed media type — never the client-supplied one " +
          "— and inline only for images. Authorization is re-checked here on every request.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          // The `content` form documents the body for OpenAPI without handing the stream to the
          // JSON serialiser, which has no way to represent bytes.
          200: { content: { "*/*": { schema: { type: "string", format: "binary" } } } },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      try {
        const { file, body } = await deps.files.content(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        reply.headers(downloadHeaders(file));
        // Returned rather than sent: an async handler's resolved value wins over an earlier
        // `reply.send`, so sending here would be silently replaced by an empty body.
        //
        // `Readable.from` because Fastify streams a Node stream but not a bare async iterable, and
        // `objectMode: false` because the default emits each chunk as an object, not as bytes.
        return Readable.from(body, { objectMode: false });
      } catch (error) {
        reject(reply, error);
        return undefined;
      }
    }
  );
}
