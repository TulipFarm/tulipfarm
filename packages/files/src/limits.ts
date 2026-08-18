/**
 * What may be uploaded, in one place.
 *
 * These are the concrete limits the feature is built against. They live here rather than in a
 * route or a component because three layers have to agree on them — the browser refuses an
 * over-limit file before it sends anything, the route refuses it again from the declared length,
 * and the sniffer refuses a type the allowlist does not name.
 */

/**
 * The largest object a single upload may carry.
 *
 * 25 MiB is the smallest of the limits that actually bind downstream: it clears every image a
 * phone or a screenshot tool produces and a document-length PDF, while staying under the request
 * body ceilings of the model providers whose vision endpoints slice 04 will call.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** How many Files one message may carry. Bounds prompt assembly, not storage. */
export const MAX_FILES_PER_MESSAGE = 10;

/**
 * The types an upload may resolve to *after* sniffing.
 *
 * An allowlist, never a blocklist: a blocklist is a promise to have thought of every dangerous
 * format, and the set of those grows without us.
 *
 * SVG is deliberately absent. It is XML that may carry script, so serving one from this
 * application's own origin is stored cross-site scripting against the app's own session — and
 * unlike the raster formats it cannot be made safe by sniffing, because a valid SVG and a
 * malicious SVG have the same magic bytes.
 */
export const ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

const ALLOWED = new Set<string>(ALLOWED_MEDIA_TYPES);

export function isAllowedMediaType(mediaType: string): mediaType is AllowedMediaType {
  return ALLOWED.has(mediaType);
}

/**
 * Whether a type may be sent to the browser with an inline disposition.
 *
 * Only images. Everything else — a PDF viewer, a text file, a Markdown file — is served as an
 * attachment, because inline rendering of a non-image from our own origin hands the file's author
 * a script context on the app's session.
 */
export function isInlineRenderable(mediaType: string): boolean {
  return mediaType.startsWith("image/") && isAllowedMediaType(mediaType);
}
