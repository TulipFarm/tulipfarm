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
  downloadHeaders,
  FILE_WIRE_SCHEMA,
  type FileService,
  fileErrorStatus,
  serializeFile,
} from "@tulipfarm/files";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import type { RequestPrincipal } from "../identity/principal";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface FileRoutesDeps {
  readonly files: FileService;
}

function reject(reply: FastifyReply, error: unknown): void {
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
    "/api/v1/files",
    {
      preHandler: requireAuth,
      schema: {
        description: "The Files owned by the calling Principal, newest first.",
        tags: ["files"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        },
        response: {
          200: {
            type: "object",
            required: ["files"],
            properties: { files: { type: "array", items: FILE_WIRE_SCHEMA } },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req) => {
      const principal = req.principal as RequestPrincipal;
      const { limit = 50 } = req.query as { limit?: number };
      const files = await deps.files.list(DEPLOYMENT_BUSINESS_ID, principal.id, limit);
      return { files: files.map(serializeFile) };
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
        reply.send(serializeFile(await deps.files.read(DEPLOYMENT_BUSINESS_ID, id, principal.id)));
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
