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
  "application/json",
  "application/xml",
  "application/yaml",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

const ALLOWED = new Set<string>(ALLOWED_MEDIA_TYPES);

export function isAllowedMediaType(mediaType: string): mediaType is AllowedMediaType {
  return ALLOWED.has(mediaType);
}

const OFFICE_MEDIA_TYPE_BY_EXTENSION = new Map<string, AllowedMediaType>([
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

/**
 * The allowed upload claim for a browser File.
 *
 * Some browsers report OOXML Files as `application/zip` or no type at all. Their extension is
 * only used to make the claim; the server still verifies the ZIP entries before storing it.
 */
export function uploadMediaType(mediaType: string, filename: string): AllowedMediaType | null {
  if (isAllowedMediaType(mediaType)) return mediaType;
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return OFFICE_MEDIA_TYPE_BY_EXTENSION.get(extension) ?? null;
}

/**
 * Whether a type may be sent to the browser with an inline disposition.
 *
 * Only images. Everything else — a PDF viewer, a text file, a Markdown file — is served as an
 * attachment, because inline rendering of a non-image from our own origin hands the file's author
 * a script context on the app's session.
 */
export function isInlineRenderable(mediaType: string): boolean {
  return isImageMediaType(mediaType) && isAllowedMediaType(mediaType);
}

/**
 * Whether a type is an image at all, before any allowlist or policy narrows it further.
 *
 * Four questions in this package start here and then diverge — may it be downscaled, may it be
 * rendered inline, can text be pulled out of it, does it need bounding. Each keeps its own
 * function; only the shared first step lives here, so a change to what counts as an image is one
 * edit rather than four.
 */
export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

/**
 * Which allowed types an Agent can be handed as text rather than as bytes.
 *
 * A Tool result is JSON with no binary channel, so this is the line between the two answers
 * `file_read` can give: a textual File comes back inline as characters, and everything else — an
 * image, a PDF — is re-attached to the Turn so the model reads the object itself. Deriving the
 * split from the type rather than from the caller is what stops an image being described as
 * mojibake.
 */
export const TEXTUAL_MEDIA_TYPES = [
  "application/json",
  "application/xml",
  "application/yaml",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

const TEXTUAL = new Set<string>(TEXTUAL_MEDIA_TYPES);

export function isTextualMediaType(mediaType: string): boolean {
  return TEXTUAL.has(mediaType);
}

/**
 * The most characters `file_read` returns from a textual File.
 *
 * Matches the largest block cap context assembly already applies (pinned knowledge, eager Skills),
 * so a re-read document cannot claim more of the window than any other single source. An
 * unbounded read is the failure this exists to prevent: a 25 MiB text File would exhaust both the
 * window and the Run's token budget in one call.
 */
/**
 * Who owns a File an Agent made.
 *
 * An Agent has no self to own anything, and pinning machine-made output to whoever happened to
 * trigger the Run would orphan a Routine's monthly report the day that person is offboarded. So
 * the business is the owner of record, and the person who asked is given a share.
 *
 * Deliberately not a Principal row: nothing authenticates as the business, so a row would be an
 * account nobody holds. It is an owner identifier and only ever compared as one.
 */
/**
 * Whether a type carries text an indexer could pull out of it.
 *
 * Lives here rather than beside the extractor because the browser has to ask it too: the Files
 * library must not offer "add to knowledge" for a type the request would only refuse, and the two
 * answers have to come from one rule or they will drift.
 */
export function isExtractableMediaType(mediaType: string): boolean {
  return isTextualMediaType(mediaType) || mediaType === "application/pdf";
}

export const BUSINESS_PRINCIPAL_ID = "business";

export const MAX_FILE_READ_CHARS = 32_000;

/** How many Files `file_list` returns at once, and the most a caller may ask for. */
export const DEFAULT_FILE_LIST_LIMIT = 20;
export const MAX_FILE_LIST_LIMIT = 50;
