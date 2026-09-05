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
  draftDownloadHeaders,
  FILE_EXPECTED_REVISION_SCHEMA,
  FILE_FOLDER_WIRE_SCHEMA,
  FILE_FOLDERS_SCHEMA,
  FILE_GRANTEE_KINDS,
  FILE_GRANTEE_SCHEMA,
  FILE_PAGE_QUERY_SCHEMA,
  FILE_PAGE_SCHEMA,
  FILE_SEARCH_QUERY_SCHEMA,
  FILE_SEARCH_SCHEMA,
  FILE_SHARES_SCHEMA,
  FILE_VERSIONS_SCHEMA,
  FILE_WIRE_SCHEMA,
  type FileCursor,
  type FileGrantee,
  type FileGranteeKind,
  type FileRecord,
  type FileService,
  fileErrorStatus,
  serializeFile,
  serializeFileFolder,
  serializeFilePage,
  serializeFileVersion,
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
  /**
   * Display names for many Principals at once.
   *
   * Batched rather than per-id because a page of 50 Files can hold 50 distinct owners, and the
   * Files page pulls many pages in a row whenever a filter is applied — which turned one listing
   * into hundreds of user lookups.
   */
  readonly principalNames: (
    principalIds: readonly string[]
  ) => Promise<ReadonlyMap<string, string | null>>;
}

function resolveOwnerNames(
  files: readonly FileRecord[],
  principalNames: FileRoutesDeps["principalNames"]
): Promise<ReadonlyMap<string, string | null>> {
  return principalNames([...new Set(files.map((file) => file.ownerPrincipalId))]);
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
  deps: FileRoutesDeps
): Promise<FastifyReply> {
  const { limit = 50, after } = req.query as { limit?: number; after?: string };
  const cursor = after === undefined ? undefined : decodeFileCursor(after);
  if (cursor === null) {
    return reply.code(400).send({ error: "that cursor is not one of ours" });
  }
  const result = await page((req.principal as RequestPrincipal).id, limit, cursor);
  // Asked only for a listing that already carries share counts, which is the owner's listing.
  // Whether a File is in Knowledge is the owner's business for the same reason its share count is.
  const knowledgeIds =
    deps.knowledge && result.shareCounts
      ? await deps.knowledge.indexedIds(result.files.map((file) => file.id))
      : undefined;
  const ownerNames = await resolveOwnerNames(result.files, deps.principalNames);
  // Returns the reply rather than resolving `undefined`: an async handler that resolves undefined
  // after calling `reply.send()` leaves Fastify unsure whether the reply was handled, and once the
  // payload is large enough for compression to turn it into a stream that ambiguity truncates the
  // response to `content-length: 0`.
  return reply.send(
    serializeFilePage({
      ...result,
      ownerNames,
      ...(knowledgeIds === undefined ? {} : { knowledgeIds }),
    })
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
            properties: {
              filename: { type: "string", minLength: 1 },
              folderId: { type: "string", format: "uuid" },
            },
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
        const { filename, folderId } = req.query as { filename: string; folderId?: string };
        const declared = Number(req.headers["content-length"] ?? 0);
        const claimed = (req.headers["content-type"] ?? "application/octet-stream")
          .split(";")[0]
          .trim();

        try {
          const file = await deps.files.upload({
            businessId: DEPLOYMENT_BUSINESS_ID,
            ownerPrincipalId: principal.id,
            ...(folderId === undefined ? {} : { folderId }),
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

    scope.put(
      "/api/v1/files/:id/content",
      {
        preHandler: requireAuth,
        schema: {
          description:
            "Replaces a File's current content with a new immutable version. The verified media " +
            "type must match the current version, and `expectedRevision` prevents lost updates.",
          tags: ["files"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          querystring: FILE_EXPECTED_REVISION_SCHEMA,
          response: {
            200: FILE_WIRE_SCHEMA,
            400: ErrorSchema,
            401: ErrorSchema,
            404: ErrorSchema,
            409: ErrorSchema,
            413: ErrorSchema,
            415: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const principal = req.principal as RequestPrincipal;
        const { id } = req.params as { id: string };
        const { expectedRevision } = req.query as { expectedRevision: number };
        const declared = Number(req.headers["content-length"] ?? 0);
        const claimed = (req.headers["content-type"] ?? "application/octet-stream")
          .split(";")[0]
          .trim();
        try {
          const file = await deps.files.replace({
            businessId: DEPLOYMENT_BUSINESS_ID,
            ownerPrincipalId: principal.id,
            fileId: id,
            expectedRevision,
            claimedMediaType: claimed,
            declaredBytes: Number.isFinite(declared) ? declared : 0,
            body: req.body as AsyncIterable<Uint8Array>,
          });
          if (file.knowledgeRequestedAt !== null) {
            await deps.knowledge?.remove(id);
            await deps.knowledge?.requestIndex(id, file.currentVersionId, principal.id);
          }
          reply.send(serializeFile(file));
        } catch (error) {
          reject(reply, error);
        }
      }
    );
  });

  app.get(
    "/api/v1/file-folders",
    {
      preHandler: requireAuth,
      schema: {
        description: "Lists the calling Principal's File folders.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: FILE_FOLDERS_SCHEMA, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const folders = await deps.files.folders(DEPLOYMENT_BUSINESS_ID, principal.id);
      return reply.send({ folders: folders.map(serializeFileFolder) });
    }
  );

  app.post(
    "/api/v1/file-folders",
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
          "Creates a File folder owned by the calling Principal. A parent creates a nested folder.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            parentId: { type: "string", format: "uuid", nullable: true },
          },
          additionalProperties: false,
        },
        response: {
          201: FILE_FOLDER_WIRE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { name, parentId } = req.body as { name: string; parentId?: string | null };
      try {
        const folder = await deps.files.createFolder(
          DEPLOYMENT_BUSINESS_ID,
          principal.id,
          name,
          parentId ?? undefined
        );
        reply.code(201).send(serializeFileFolder(folder));
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.patch(
    "/api/v1/file-folders/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Renames a File folder the calling Principal owns.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
          additionalProperties: false,
        },
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 120 } },
          additionalProperties: false,
        },
        response: {
          200: FILE_FOLDER_WIRE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      const { name } = req.body as { name: string };
      try {
        const folder = await deps.files.renameFolder(
          DEPLOYMENT_BUSINESS_ID,
          id,
          principal.id,
          name
        );
        return reply.send(serializeFileFolder(folder));
      } catch (error) {
        return reject(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/file-folders/:id",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Deletes an empty File folder the calling Principal owns. Refuses while it holds a File or a nested folder, so nothing is destroyed by implication.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
          additionalProperties: false,
        },
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
        await deps.files.deleteFolder(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        return reply.code(204).send();
      } catch (error) {
        return reject(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/files/:id/move",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Moves an owned active File into a folder, or to the root when folderId is null.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          required: ["folderId", "expectedRevision"],
          properties: {
            folderId: { type: "string", format: "uuid", nullable: true },
            expectedRevision: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
        response: {
          200: FILE_WIRE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      const { folderId, expectedRevision } = req.body as {
        folderId: string | null;
        expectedRevision: number;
      };
      try {
        const moved = await deps.files.move(
          DEPLOYMENT_BUSINESS_ID,
          id,
          principal.id,
          folderId,
          expectedRevision
        );
        reply.send(serializeFile(moved));
      } catch (error) {
        reject(reply, error);
      }
    }
  );

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
    "/api/v1/file-drafts/:id/content",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Downloads an unexpired generated File draft. A draft is private to the person whose " +
          "Chat created it and does not appear in the Files library until that person saves it.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
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
        const { draft, body } = await deps.files.draftContent(
          DEPLOYMENT_BUSINESS_ID,
          id,
          principal.id
        );
        reply.headers(draftDownloadHeaders(draft));
        return Readable.from(body, { objectMode: false });
      } catch (error) {
        reject(reply, error);
        return undefined;
      }
    }
  );

  app.post(
    "/api/v1/file-drafts/:id/save",
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
          "Saves an unexpired generated draft into the Files library. Repeating the request " +
          "returns the same File, so a browser retry cannot create a duplicate.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: FILE_WIRE_SCHEMA,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      try {
        const file = await deps.files.saveDraft(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        reply.send(serializeFile(file));
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/files/search",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Searches filenames across the Files the caller can currently read. File contents are " +
          "never searched, and revoked shares disappear from results on the next request.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: FILE_SEARCH_QUERY_SCHEMA,
        response: {
          200: FILE_SEARCH_SCHEMA,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { q, limit = 10 } = req.query as { q: string; limit?: number };
      const files = await deps.files.search(DEPLOYMENT_BUSINESS_ID, principal.id, q, limit);
      const shareCounts = await deps.files.shareCountsFor(
        DEPLOYMENT_BUSINESS_ID,
        principal.id,
        files
      );
      const ownedIds = files
        .filter((file) => file.ownerPrincipalId === principal.id)
        .map((file) => file.id);
      const knowledgeIds =
        deps.knowledge && ownedIds.length > 0
          ? await deps.knowledge.indexedIds(ownedIds)
          : new Set<string>();
      const ownerNames = await resolveOwnerNames(files, deps.principalNames);
      return reply.send({
        files: files.map((file) =>
          file.ownerPrincipalId === principal.id
            ? serializeFile(
                file,
                shareCounts.get(file.id) ?? 0,
                knowledgeIds.has(file.id),
                ownerNames.get(file.ownerPrincipalId)
              )
            : serializeFile(file, undefined, undefined, ownerNames.get(file.ownerPrincipalId))
        ),
      });
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
        deps
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
      await sendPage(
        req,
        reply,
        (id, limit, cursor) =>
          deps.files.listSharedWithMe(DEPLOYMENT_BUSINESS_ID, id, limit, cursor),
        deps
      )
  );

  app.get(
    "/api/v1/files/archived",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "The archived Files owned by the calling Principal. Archived Files remain readable " +
          "but are absent from active discovery and new attachments.",
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
        (id, limit, cursor) =>
          deps.files.listArchivedPage(DEPLOYMENT_BUSINESS_ID, id, limit, cursor),
        deps
      )
  );

  app.get(
    "/api/v1/files/:id/versions",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Lists the immutable content history of a File. Only the File owner may inspect prior " +
          "versions until Editor grants are available.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: FILE_VERSIONS_SCHEMA, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      try {
        const versions = await deps.files.versions(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        return reply.send({ versions: versions.map(serializeFileVersion) });
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/files/:id/versions/:versionId/content",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Downloads one immutable File version. Only the owner may inspect historical bytes.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id", "versionId"],
          properties: { id: { type: "string" }, versionId: { type: "string" } },
        },
        response: {
          200: { content: { "*/*": { schema: { type: "string", format: "binary" } } } },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id, versionId } = req.params as { id: string; versionId: string };
      try {
        const { file, version, body } = await deps.files.versionContent(
          DEPLOYMENT_BUSINESS_ID,
          id,
          versionId,
          principal.id
        );
        reply.headers(
          downloadHeaders({
            ...file,
            mediaType: version.mediaType,
            claimedMediaType: version.claimedMediaType,
            sizeBytes: version.sizeBytes,
            blob: version.blob,
          })
        );
        return Readable.from(body, { objectMode: false });
      } catch (error) {
        reject(reply, error);
        return undefined;
      }
    }
  );

  app.post(
    "/api/v1/files/:id/versions/:versionId/restore",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Restores historical content by creating a new immutable latest version that reuses " +
          "the historical blob. Only the owner may restore a version.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id", "versionId"],
          properties: { id: { type: "string" }, versionId: { type: "string" } },
        },
        body: FILE_EXPECTED_REVISION_SCHEMA,
        response: {
          200: FILE_WIRE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id, versionId } = req.params as { id: string; versionId: string };
      const { expectedRevision } = req.body as { expectedRevision: number };
      try {
        const file = await deps.files.restoreVersion({
          businessId: DEPLOYMENT_BUSINESS_ID,
          ownerPrincipalId: principal.id,
          fileId: id,
          versionId,
          expectedRevision,
        });
        if (file.knowledgeRequestedAt !== null) {
          await deps.knowledge?.remove(id);
          await deps.knowledge?.requestIndex(id, file.currentVersionId, principal.id);
        }
        reply.send(serializeFile(file));
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/files/:id/archive",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Archives a File at an expected revision. Archived Files disappear from discovery and " +
          "new attachments, but existing readers may still open them.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: FILE_EXPECTED_REVISION_SCHEMA,
        response: {
          200: FILE_WIRE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      const { expectedRevision, ownershipOperationId } = req.body as {
        expectedRevision: number;
        ownershipOperationId?: string;
      };
      try {
        const file = await deps.files.archive(
          DEPLOYMENT_BUSINESS_ID,
          id,
          principal.id,
          expectedRevision,
          async () => {
            await deps.knowledge?.remove(id);
          },
          ownershipOperationId
        );
        reply.send(serializeFile(file));
      } catch (error) {
        reject(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/files/:id/restore",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Restores an archived File at an expected revision. Its remembered Knowledge opt-in " +
          "is re-enqueued automatically.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: FILE_EXPECTED_REVISION_SCHEMA,
        response: {
          200: FILE_WIRE_SCHEMA,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      const { expectedRevision } = req.body as { expectedRevision: number };
      try {
        const file = await deps.files.restoreArchive(
          DEPLOYMENT_BUSINESS_ID,
          id,
          principal.id,
          expectedRevision
        );
        if (file.knowledgeRequestedAt !== null) {
          await deps.knowledge?.requestIndex(id, file.currentVersionId, principal.id);
        }
        reply.send(serializeFile(file));
      } catch (error) {
        reject(reply, error);
      }
    }
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
        return reply.send({ shares: shares.map(serializeShare) });
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
          "Permanently deletes an archived File and queues every unreferenced version blob for " +
          "durable cleanup. Only the owner may delete it.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        querystring: FILE_EXPECTED_REVISION_SCHEMA,
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal as RequestPrincipal;
      const { id } = req.params as { id: string };
      const { expectedRevision, ownershipOperationId } = req.query as {
        expectedRevision: number;
        ownershipOperationId?: string;
      };
      try {
        const destroyed = await deps.files.delete(
          DEPLOYMENT_BUSINESS_ID,
          id,
          principal.id,
          expectedRevision,
          ownershipOperationId
        );
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
        const owned = await deps.files.canManage(DEPLOYMENT_BUSINESS_ID, id, principal.id);
        const shareCount = owned
          ? ((await deps.files.shareCountsFor(DEPLOYMENT_BUSINESS_ID, principal.id, [file])).get(
              file.id
            ) ?? 0)
          : undefined;
        const inKnowledge =
          deps.knowledge && owned ? await deps.knowledge.isIndexed(id) : undefined;
        return reply.send(
          serializeFile(
            file,
            shareCount,
            inKnowledge,
            (await deps.principalNames([file.ownerPrincipalId])).get(file.ownerPrincipalId) ?? null,
            owned
          )
        );
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
