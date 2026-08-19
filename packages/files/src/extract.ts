/**
 * Turning a File's bytes into text, in one place.
 *
 * Two callers need this and they must not answer it differently: `file_read` hands an Agent a
 * document inline, and Knowledge indexing chunks one for retrieval. If each decided for itself
 * what "the text of this File" means, a person could be shown a passage in chat that the search
 * over the same File cannot find, or the reverse — and neither would look like a bug from either
 * side.
 *
 * The parser is loaded on demand rather than imported at module scope. Both applications import
 * this package, but only the Worker ever extracts; a lazy import is what keeps a PDF engine out of
 * the process that terminates people's HTTP requests, which is the same reason document rendering
 * was put in the Worker to begin with.
 */

import { isTextualMediaType } from "./limits";

/**
 * Why a File yielded no text.
 *
 * Refusals are values, not exceptions, because every one of them is an ordinary outcome for some
 * legitimate File: a scan has no text layer, and an image never will. A caller has to render each
 * differently, and a thrown error would flatten them into "something went wrong".
 */
export type ExtractionRefusal =
  /** Not a type this extracts from at all. */
  | "unsupported_media_type"
  /** An image. Deliberately never indexed — see `IMAGES_ARE_NOT_INDEXED`. */
  | "image_not_extractable"
  /** A PDF that parsed, but carries no text layer — a scan, or pages of pure artwork. */
  | "no_text_layer"
  /** A PDF that would not parse. Corrupt, encrypted, or not really a PDF. */
  | "unreadable";

export interface ExtractedText {
  readonly kind: "text";
  readonly text: string;
  /** Whether the cap cut the document short. Callers say so rather than implying completeness. */
  readonly truncated: boolean;
}

export interface ExtractionRefused {
  readonly kind: "refused";
  readonly reason: ExtractionRefusal;
}

export type ExtractionResult = ExtractedText | ExtractionRefused;

/**
 * Images are not indexed, and this is the decision rather than an omission.
 *
 * Running OCR would mean asserting that whatever it returned is the content of the picture, and a
 * wrong assertion is worse here than no assertion: an Agent citing hallucinated text back to a
 * source the person can see is a trust failure, not a quality one. Images already reach the model
 * intact — vision attachment shows the model the picture itself — so the capability a person
 * actually wants is not lost, it is served by the path that cannot be wrong about what it read.
 */
export const IMAGES_ARE_NOT_INDEXED = true;

/**
 * The most text one File contributes.
 *
 * A 25 MiB PDF can hold several million characters, and every one of them would be chunked,
 * embedded and stored. The cap bounds what a single upload can cost the index; the `truncated`
 * flag is what stops that bound from being silently mistaken for the whole document.
 */
export const MAX_EXTRACTED_CHARS = 200_000;

export interface ExtractOptions {
  /** Cap the returned text. Defaults to `MAX_EXTRACTED_CHARS`. */
  readonly maxChars?: number;
}

/**
 * Extract a File's text, or say why there is none.
 *
 * Never throws for a File's own content: a PDF that will not parse is `unreadable`, not an
 * exception, because the caller's next step is the same either way.
 */
export async function extractText(
  mediaType: string,
  bytes: Uint8Array,
  options: ExtractOptions = {}
): Promise<ExtractionResult> {
  const maxChars = options.maxChars ?? MAX_EXTRACTED_CHARS;

  if (isTextualMediaType(mediaType)) {
    return capped(new TextDecoder().decode(bytes), maxChars);
  }
  if (mediaType.startsWith("image/")) {
    return { kind: "refused", reason: "image_not_extractable" };
  }
  if (mediaType === "application/pdf") {
    return await extractPdf(bytes, maxChars);
  }
  return { kind: "refused", reason: "unsupported_media_type" };
}

/** Whether `extractText` could return text for a type, without reading any bytes to find out. */
export function isExtractableMediaType(mediaType: string): boolean {
  return isTextualMediaType(mediaType) || mediaType === "application/pdf";
}

async function extractPdf(bytes: Uint8Array, maxChars: number): Promise<ExtractionResult> {
  let text: string;
  try {
    const { extractText: extractPdfText, getDocumentProxy } = await import("unpdf");
    // Silent: a malformed File is an expected outcome here, and pdf.js otherwise writes its
    // recovery warnings to stderr, where they read as faults in the Worker rather than as facts
    // about someone's upload.
    const document = await getDocumentProxy(bytes, { verbosity: 0 });
    const extracted = await extractPdfText(document, { mergePages: true });
    text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
  } catch {
    // The bytes are the untrusted input here, so a parser failure describes the File rather than
    // the system: encrypted, truncated or simply not a PDF all arrive as the same refusal.
    return { kind: "refused", reason: "unreadable" };
  }

  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) {
    return { kind: "refused", reason: "no_text_layer" };
  }
  return capped(normalized, maxChars);
}

function capped(text: string, maxChars: number): ExtractedText {
  return text.length > maxChars
    ? { kind: "text", text: text.slice(0, maxChars), truncated: true }
    : { kind: "text", text, truncated: false };
}

/**
 * Collapse the whitespace a PDF text layer arrives with.
 *
 * Page extraction emits a lot of incidental spacing — line breaks mid-sentence, runs of spaces
 * standing in for layout. Left alone it survives into chunk boundaries and embeddings, where it is
 * noise that shifts what a passage matches.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
