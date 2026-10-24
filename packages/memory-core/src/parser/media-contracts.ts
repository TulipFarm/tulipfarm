import { z } from 'zod';
import { knowledgeLimits } from '../document-contracts.js';

export const mediaLimits = Object.freeze({
  /** Images smaller than this on both sides are decoration and are skipped without a gap. */
  minimumSide: 32,
  /** Distinct recognitions per revision; the rest become coverage gaps. */
  recognitionsPerRevision: 300,
  /** Distinct recognitions per file under the `images` rules; the rest become `limit` gaps. */
  recognitionsPerFile: 100,
  /** Largest image or rendered page sent to the model, after normalization. */
  imageBytes: 8 * 1024 * 1024,
  /** Raw media bytes returned by one sandbox media call. */
  batchBytes: 24 * 1024 * 1024,
  /** Media items requested from one sandbox media call. */
  batchItems: 20,
  /** Longest side of a rendered PDF page, in pixels. */
  renderSide: 1600,
  altBytes: 4096,
  fallbackBytes: 256 * 1024,
});

export const mediaIdSchema = z.string().regex(/^m[0-9]{1,5}$/);
export type MediaId = z.infer<typeof mediaIdSchema>;

const placeholderStart = '\uE000';
const placeholderEnd = '\uE001';
export const placeholderPattern = /\uE000media:(m[0-9]{1,5})\uE001/g;

export function mediaPlaceholder(id: MediaId): string {
  return `${placeholderStart}media:${id}${placeholderEnd}`;
}

/** Source text must not forge placeholders. */
export function stripPlaceholderMarkers(text: string): string {
  return text.replace(/[\uE000\uE001]/g, '');
}

export const locationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('passage') }),
  z.strictObject({ kind: z.literal('page'), page: z.number().int().min(1).max(knowledgeLimits.pages) }),
  z.strictObject({ kind: z.literal('slide'), slide: z.number().int().min(1).max(knowledgeLimits.pages) }),
  z.strictObject({
    kind: z.literal('sheet'),
    sheet: z.number().int().min(1).max(knowledgeLimits.pages),
    name: z.string().max(256),
  }),
]);
export type KnowledgeLocation = z.infer<typeof locationSchema>;

/** Stateless address the sandbox uses to find the media again in the same original bytes. */
export const mediaRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('part'), path: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('pdf-page'), page: z.number().int().min(1).max(knowledgeLimits.pages) }),
  z.strictObject({ kind: z.literal('rtf-picture'), index: z.number().int().min(0).max(100_000) }),
  /** The whole input is one image. */
  z.strictObject({ kind: z.literal('file') }),
]);
export type MediaRef = z.infer<typeof mediaRefSchema>;

export const mediaItemSchema = z.strictObject({
  id: mediaIdSchema,
  /** `page` replaces a whole PDF page; `image` is one embedded picture. */
  kind: z.enum(['image', 'page']),
  ref: mediaRefSchema,
  location: locationSchema,
  /** Author-provided description, if any. */
  alt: z.string().refine(value => Buffer.byteLength(value) <= mediaLimits.altBytes),
  /** Markdown used when the media is not recognized (alt text for images, extracted text for PDF pages). */
  fallback: z.string().refine(value => Buffer.byteLength(value) <= mediaLimits.fallbackBytes),
  /** Content hash of the stored media, when the sandbox can compute it before rendering. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type MediaItem = z.infer<typeof mediaItemSchema>;

export const gapKindSchema = z.enum(['image', 'video', 'audio', 'object', 'other']);
export const gapReasonSchema = z.enum([
  /** No decoder or no recognition path for this media type. */
  'unsupported-media',
  /** Recognition was off, had no document-vision model, or had no credits. */
  'recognition-unavailable',
  'refused',
  'empty',
  /** Over the per-revision recognition cap or the image size limit. */
  'limit',
]);
export const coverageGapSchema = z.strictObject({
  kind: gapKindSchema,
  reason: gapReasonSchema,
  location: locationSchema,
  /** Alt text, file name or other label shown to readers. */
  label: z.string().max(512),
});
export type CoverageGap = z.infer<typeof coverageGapSchema>;

export const segmentSchema = z.strictObject({
  location: locationSchema,
  markdown: z.string(),
});
export type ExtractionSegment = z.infer<typeof segmentSchema>;

/** First sandbox call: text with placeholders, media to recognize and gaps found during extraction. */
export const extractionSchema = z.strictObject({
  engine: z.enum(['text', 'anydoc', 'image']),
  version: z.string(),
  normalization: z.string(),
  pages: z.number().int().min(0).max(knowledgeLimits.pages),
  segments: z
    .array(segmentSchema)
    .min(1)
    .max(knowledgeLimits.pages + 1),
  media: z.array(mediaItemSchema).max(10_000),
  gaps: z.array(coverageGapSchema).max(10_000),
  /** The converter failure that raw-text indexing replaced. */
  fallback: z.enum(['unsupported', 'malformed']).optional(),
});
export type KnowledgeExtraction = z.infer<typeof extractionSchema>;

export const recognizableMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export type RecognizableMediaType = z.infer<typeof recognizableMediaTypeSchema>;

/**
 * Second sandbox call header. The stdout is this JSON on one line, a newline, then the bytes of every `ready`
 * item concatenated in header order.
 */
export const mediaBatchHeaderSchema = z.strictObject({
  kind: z.literal('media'),
  items: z.array(
    z.discriminatedUnion('status', [
      z.strictObject({
        id: mediaIdSchema,
        status: z.literal('ready'),
        mediaType: recognizableMediaTypeSchema,
        width: z.number().int().min(1),
        height: z.number().int().min(1),
        byteLength: z.number().int().min(1).max(mediaLimits.imageBytes),
      }),
      z.strictObject({ id: mediaIdSchema, status: z.literal('too-small') }),
      z.strictObject({ id: mediaIdSchema, status: z.literal('too-large') }),
      z.strictObject({ id: mediaIdSchema, status: z.literal('unsupported') }),
      /** Left out because the batch reached `batchBytes`; the host asks again in a later batch. */
      z.strictObject({ id: mediaIdSchema, status: z.literal('deferred') }),
    ]),
  ),
});
export type MediaBatchHeader = z.infer<typeof mediaBatchHeaderSchema>;

export interface MediaBytes {
  id: MediaId;
  mediaType: RecognizableMediaType;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export type MediaRecognition =
  | { kind: 'recognized'; text: string; description: string }
  | { kind: 'refused' }
  | { kind: 'empty' };

export const mediaRecognitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('recognized'), text: z.string(), description: z.string() }),
  z.strictObject({ kind: z.literal('refused') }),
  z.strictObject({ kind: z.literal('empty') }),
]);

export interface MediaRecognitionRequest {
  kind: 'image' | 'page';
  mediaType: RecognizableMediaType;
  bytes: Uint8Array;
  width: number;
  height: number;
  alt: string;
  signal?: AbortSignal;
}

/** Recognition can't start or continue now, such as when credits run out. Remaining media become gaps. */
export class MediaRecognitionUnavailable extends Error {
  constructor(message = 'Media recognition is unavailable') {
    super(message);
    this.name = 'MediaRecognitionUnavailable';
  }
}

/** The model call failed or returned an invalid response. The revision's parse fails and is retried. */
export class MediaRecognitionFailed extends Error {
  constructor(message = 'Media recognition failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MediaRecognitionFailed';
  }
}

/** Host port the worker wires to inference, model cost, credits and the owning workspace. */
export interface MediaRecognizer {
  /** Catalog id of the document-vision model. Part of the parser profile and the cache key. */
  readonly modelId: string;
  /** Changes whenever the prompt or response format changes. Part of the parser profile and the cache key. */
  readonly promptVersion: string;
  recognize(request: MediaRecognitionRequest): Promise<MediaRecognition>;
}

/** Workspace-scoped reuse of recognitions. Keys already include the model id and prompt version. */
export interface MediaRecognitionCache {
  get(key: string): Promise<MediaRecognition | undefined>;
  /** `source` is the SHA-256 of the file the media came from; the recognition is kept while a file holds it. */
  set(key: string, value: MediaRecognition, source: string): Promise<void>;
}

export interface KnowledgeRecognitionOptions {
  /** Absent when recognition is off for the workspace or no model reads images for it. */
  recognizer?: MediaRecognizer;
  cache?: MediaRecognitionCache;
  signal?: AbortSignal;
  /** `throw` (the default) fails the parse so it is retried; `count` keeps the item's fallback and counts it. */
  failedRecognition?: 'throw' | 'count';
  /**
   * The workspace `images` flag's rules: a file recognises at most `recognitionsPerFile` units, an unavailable
   * recognition (such as a refused credit reservation) gaps only its own unit, recognised media is labelled
   * `[Recognised image]`, and a standalone image file is read as one unit.
   */
  images?: boolean;
}

/** One image or page ready for the recognizer, from a document or a file that is itself an image. */
export type RecognitionUnit = Omit<MediaRecognitionRequest, 'signal'> & { sha256?: string };

/** What recognising one unit produced: its recognition, or why it has none. */
export type RecognitionOutcome =
  | MediaRecognition
  | { kind: 'limit' }
  | { kind: 'recognition-unavailable' }
  | { kind: 'failed' };

/** Marks recognised text so a reader can tell it apart from the file's own text. */
export const recognisedLabel = '[Recognised image]';

export function recognitionCacheKey(sha256: string, recognizer: Pick<MediaRecognizer, 'modelId' | 'promptVersion'>) {
  return `${sha256}:${recognizer.modelId}:${recognizer.promptVersion}`;
}
