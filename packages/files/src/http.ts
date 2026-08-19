/**
 * How a File appears on an HTTP wire.
 *
 * None of this touches Fastify. What a File looks like as JSON, which status a refusal deserves,
 * and which headers make serving user-supplied bytes safe are all facts about Files — so they live
 * beside the rules that produced them rather than in whichever app happens to serve them.
 */

import { isInlineRenderable } from "./limits";
import { FILE_ORIGINS, type FileRecord } from "./repo";
import { FileError } from "./service";

/** The wire shape, shared by the route schemas and the serializer so they cannot drift. */
export const FILE_WIRE_SCHEMA = {
  type: "object",
  required: ["id", "filename", "mediaType", "sizeBytes", "createdAt", "owner", "origin"],
  properties: {
    id: { type: "string" },
    filename: { type: "string" },
    mediaType: { type: "string" },
    sizeBytes: { type: "integer" },
    createdAt: { type: "string" },
    /** The owning Principal's id. A display name needs a lookup the File itself cannot do. */
    owner: { type: "string" },
    origin: { type: "string", enum: [...FILE_ORIGINS] },
    // `chatId` on the wire, `source_conversation_id` in the table: Chat is the external word for
    // the same thing, and the boundary between them is exactly here.
    sourceChatId: { type: "string", nullable: true },
  },
} as const;

export function serializeFile(file: FileRecord) {
  return {
    id: file.id,
    filename: file.filename,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt.toISOString(),
    owner: file.ownerPrincipalId,
    origin: file.origin,
    sourceChatId: file.sourceConversationId,
  };
}

export const FILE_ERROR_STATUS: Record<FileError["reason"], 400 | 403 | 404 | 413 | 415> = {
  too_large: 413,
  empty: 400,
  disallowed_type: 415,
  // An image over the pixel limit is a payload the instance refuses to carry, same as one over
  // the byte limit — the person's remedy is to make it smaller either way.
  image_too_large: 413,
  not_authorized: 403,
  not_found: 404,
};

export function fileErrorStatus(error: unknown): 400 | 403 | 404 | 413 | 415 | null {
  return error instanceof FileError ? FILE_ERROR_STATUS[error.reason] : null;
}

/**
 * The filename in a `Content-Disposition`, encoded twice on purpose.
 *
 * The bare `filename=` form is ASCII-only, so a non-ASCII name has to travel in `filename*` per
 * RFC 5987, with the ASCII form kept as a fallback. The value is already normalised on upload, so
 * this is encoding, not sanitisation.
 */
export function contentDisposition(file: FileRecord): string {
  const disposition = isInlineRenderable(file.mediaType) ? "inline" : "attachment";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range bounds printable ASCII.
  const ascii = file.filename.replace(/[^\x20-\x7e]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
}

/**
 * Every header a File download needs, including the two that are not optional: the bytes are
 * user-supplied, so nothing about them may be sniffed or framed by the browser whatever the type
 * claims.
 */
export function downloadHeaders(file: FileRecord): Record<string, string> {
  return {
    "content-type": file.mediaType,
    "content-length": String(file.sizeBytes),
    "content-disposition": contentDisposition(file),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
}
