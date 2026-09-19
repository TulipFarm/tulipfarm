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

import { type ImageSize, imageSize } from "./dimensions";
import { type DocumentRefusal, documentFormat } from "./document-preview";
import { isImageMediaType, isTextualMediaType } from "./limits";

export type ExtractedVisual =
  | { readonly kind: "image"; readonly width: number; readonly height: number }
  | { readonly kind: "pdf"; readonly pages: readonly ImageSize[] };

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
  /**
   * An image, always. Never OCR, and that is the decision rather than an omission: OCR would
   * assert that whatever came back is the content of the picture, and an Agent citing invented
   * text back to a source the person can see with their own eyes is a trust failure rather than a
   * quality one. Images already reach the model intact through vision attachment, so the
   * capability is not lost — it is served by the path that cannot be wrong about what it read.
   */
  | "image_not_extractable"
  /** A PDF with no text layer — a scan, or pages of pure artwork — or an empty Office document. */
  | "no_text_layer"
  /** A PDF or Office package that would not parse. Corrupt, encrypted, or not really one. */
  | DocumentRefusal;

export interface ExtractedText {
  readonly kind: "text";
  readonly text: string;
  /** Whether the cap cut the document short. Callers say so rather than implying completeness. */
  readonly truncated: boolean;
  readonly visual?: ExtractedVisual;
}

export interface ExtractionRefused {
  readonly kind: "refused";
  readonly reason: ExtractionRefusal;
  readonly visual?: ExtractedVisual;
}

export type ExtractionResult = ExtractedText | ExtractionRefused;

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
  readonly signal?: AbortSignal;
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
  const maxChars = Math.min(options.maxChars ?? MAX_EXTRACTED_CHARS, MAX_EXTRACTED_CHARS);
  if (!Number.isInteger(maxChars) || maxChars < 0) throw new RangeError("Invalid extraction cap");

  if (isTextualMediaType(mediaType)) {
    return capped(new TextDecoder().decode(bytes), maxChars);
  }
  if (isImageMediaType(mediaType)) {
    const dimensions = imageSize(bytes, mediaType);
    return {
      kind: "refused",
      reason: "image_not_extractable",
      ...(dimensions === null ? {} : { visual: { kind: "image" as const, ...dimensions } }),
    };
  }
  if (mediaType === "application/pdf") {
    const { convertDocument } = await import("./document-runner.js");
    return convertDocument("pdf", bytes, maxChars, options.signal);
  }
  const format = documentFormat(mediaType);
  if (format !== null) {
    const { convertDocument } = await import("./document-runner.js");
    return convertDocument(format, bytes, maxChars, options.signal);
  }
  return { kind: "refused", reason: "unsupported_media_type" };
}

function capped(text: string, maxChars: number): ExtractedText {
  return text.length > maxChars
    ? { kind: "text", text: text.slice(0, maxChars), truncated: true }
    : { kind: "text", text, truncated: false };
}
