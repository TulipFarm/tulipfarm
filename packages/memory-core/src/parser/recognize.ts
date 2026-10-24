import { createHash } from 'node:crypto';
import { chunkSegments, normalization, normalizeMarkdown } from './chunks.js';
import { KnowledgeParseError } from './contracts.js';
import type { KnowledgeParseInput, KnowledgeParseResult } from './contracts.js';
import { sniffImage } from './image-sniff.js';
import {
  MediaRecognitionUnavailable,
  mediaLimits,
  mediaPlaceholder,
  mediaRecognitionSchema,
  placeholderPattern,
  recognisedLabel,
  recognitionCacheKey,
  stripPlaceholderMarkers,
} from './media-contracts.js';
import type {
  CoverageGap,
  KnowledgeExtraction,
  KnowledgeLocation,
  KnowledgeRecognitionOptions,
  MediaItem,
  MediaRecognition,
  MediaRecognizer,
  RecognitionOutcome,
  RecognitionUnit,
} from './media-contracts.js';
import { extractKnowledgeDocument, readKnowledgeMedia, retryTransientParse } from './process.js';

const recognitionConcurrency = 4;

export interface KnowledgeParserSandbox {
  extract: typeof extractKnowledgeDocument;
  readMedia: typeof readKnowledgeMedia;
}

const defaultSandbox: KnowledgeParserSandbox = {
  extract: (...args) => retryTransientParse(() => extractKnowledgeDocument(...args)),
  readMedia: (...args) => retryTransientParse(() => readKnowledgeMedia(...args)),
};

/** The document's text in reading order, one segment per page, slide or sheet, with recognized media in place. */
export type KnowledgeSegments = {
  segments: { location: KnowledgeLocation; markdown: string }[];
  gaps: CoverageGap[];
  /** Media whose recognition failed, read past under `failedRecognition: 'count'`. */
  failedRecognitions: number;
  pages: number;
};

/**
 * Extracts a document in the sandbox and recognizes its media on the host, keeping each page, slide or sheet as its
 * own segment. Media that isn't recognized becomes a coverage gap; a document left with no text is `ocr-required`.
 */
export async function readKnowledgeSegments(
  input: KnowledgeParseInput,
  recognition: KnowledgeRecognitionOptions = {},
  sandbox: KnowledgeParserSandbox = defaultSandbox,
): Promise<KnowledgeSegments & { extraction: KnowledgeExtraction; used?: MediaRecognizer }> {
  const signal = recognition.signal;
  const extraction =
    recognition.images && standaloneImage(input)
      ? imageExtraction(input)
      : await sandbox.extract(input, signal ? { signal } : {});
  const outcome = await recognizeMedia(input, extraction, recognition, sandbox);
  const byId = new Map(extraction.media.map(item => [item.id, item]));
  const segments = extraction.segments.map(segment => ({
    location: segment.location,
    markdown: tidy(
      segment.markdown.replace(placeholderPattern, (_, id: string) => {
        const item = byId.get(id);
        if (!item) return '';
        const result = outcome.recognized.get(id);
        return result ? renderRecognition(item, result, { labelled: recognition.images === true }) : item.fallback;
      }),
    ),
  }));
  const gaps = [...extraction.gaps, ...outcome.gaps];
  if (!segments.some(segment => segment.markdown.trim()))
    throw new KnowledgeParseError(gaps.length || outcome.failed ? 'ocr-required' : 'malformed');
  return {
    segments,
    gaps,
    failedRecognitions: outcome.failed,
    pages: extraction.pages,
    extraction,
    ...(outcome.used ? { used: outcome.used } : {}),
  };
}

/**
 * Parses a document in the sandbox, recognizes its media on the host and chunks the merged result.
 * Media that isn't recognized becomes a coverage gap; a revision left with no text is `ocr-required`.
 */
export async function parseKnowledgeDocument(
  input: KnowledgeParseInput,
  recognition: KnowledgeRecognitionOptions = {},
  sandbox: KnowledgeParserSandbox = defaultSandbox,
): Promise<KnowledgeParseResult> {
  const { segments, gaps, extraction, used } = await readKnowledgeSegments(input, recognition, sandbox);
  const markdown = normalizeMarkdown(
    segments
      .map(segment => segment.markdown.replace(/^\n+/, '').trimEnd())
      .filter(Boolean)
      .join('\n\n'),
  );
  const { chunks, tokens } = chunkSegments(segments);
  const base = `${extraction.engine}-${extraction.version}-${extraction.normalization}`;
  const recognizer = used;
  return {
    markdown,
    pages: extraction.pages,
    tokens,
    chunks,
    gaps,
    profile: recognizer
      ? {
          id: `${base}-vision-${recognizer.modelId}-${recognizer.promptVersion}`,
          engine: extraction.engine,
          version: extraction.version,
          normalization: extraction.normalization,
          ocr: 'vision',
          ocrModel: recognizer.modelId,
          ocrPrompt: recognizer.promptVersion,
        }
      : {
          id: extraction.fallback ? `${base}-fallback` : base,
          engine: extraction.engine,
          version: extraction.version,
          normalization: extraction.normalization,
          ocr: 'disabled',
          ...(extraction.fallback ? { fallback: extraction.fallback } : {}),
        },
  };
}

interface MediaOutcome {
  recognized: Map<string, Extract<MediaRecognition, { kind: 'recognized' }>>;
  gaps: CoverageGap[];
  failed: number;
  /** Set when at least one media item went through the recognizer or its cache. */
  used?: MediaRecognizer;
}

const imageTypes = new Set(['png', 'jpeg', 'gif', 'webp', 'bmp']);

/** Whether the input is itself a raster image, judged from its header alone. */
function standaloneImage(input: KnowledgeParseInput) {
  return imageTypes.has(sniffImage(Buffer.from(input.bytes)).type);
}

/** A file that is itself an image: one passage holding one image unit, read whole by the sandbox. */
function imageExtraction(input: KnowledgeParseInput): KnowledgeExtraction {
  const location = { kind: 'passage' } as const;
  return {
    engine: 'image',
    version: '1',
    normalization,
    pages: 1,
    segments: [{ location, markdown: mediaPlaceholder('m1') }],
    media: [
      {
        id: 'm1',
        kind: 'image',
        ref: { kind: 'file' },
        location,
        alt: '',
        fallback: '',
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
      },
    ],
    gaps: [],
  };
}

/**
 * Recognition for one file: identical bytes are recognised once, the cache answers before the model and at most
 * `recognitionConcurrency` calls run at once. Under the `images` rules the first `recognitionsPerFile` distinct units
 * are recognised, cached or not, and the rest are `limit`; an unavailable recognition, such as a refused credit
 * reservation, affects only its unit. Without them, model calls past `recognitionsPerRevision` are `limit` and the
 * first unavailable recognition makes every later unit unavailable.
 */
function fileRecognition(
  recognizer: MediaRecognizer,
  { cache, signal, failedRecognition = 'throw', images }: KnowledgeRecognitionOptions,
) {
  const limit = createLimit(recognitionConcurrency);
  const results = new Map<string, Promise<RecognitionOutcome>>();
  let calls = 0;
  let available = true;
  let used = false;
  const full = () => images === true && results.size >= mediaLimits.recognitionsPerFile;
  const run = async (unit: RecognitionUnit, sha256: string): Promise<RecognitionOutcome> => {
    const key = recognitionCacheKey(sha256, recognizer);
    const cached = await cache?.get(key);
    if (cached) {
      used = true;
      return mediaRecognitionSchema.parse(cached);
    }
    if (!available) return { kind: 'recognition-unavailable' };
    if (!images && calls >= mediaLimits.recognitionsPerRevision) return { kind: 'limit' };
    calls += 1;
    try {
      const result = mediaRecognitionSchema.parse(
        await recognizer.recognize({
          kind: unit.kind,
          mediaType: unit.mediaType,
          bytes: unit.bytes,
          width: unit.width,
          height: unit.height,
          alt: unit.alt,
          ...(signal ? { signal } : {}),
        }),
      );
      used = true;
      await cache?.set(key, result);
      return result;
    } catch (error) {
      if (error instanceof MediaRecognitionUnavailable) {
        if (!images) available = false;
        return { kind: 'recognition-unavailable' };
      }
      if (failedRecognition === 'count' && !signal?.aborted) return { kind: 'failed' };
      throw new KnowledgeParseError('resource-limited', { reason: 'recognition-failed' });
    }
  };
  return {
    recognise(unit: RecognitionUnit): Promise<RecognitionOutcome> {
      const sha256 = unit.sha256 ?? createHash('sha256').update(unit.bytes).digest('hex');
      let result = results.get(sha256);
      if (!result) {
        result = full() ? Promise.resolve({ kind: 'limit' }) : limit(() => run(unit, sha256));
        results.set(sha256, result);
      }
      return result;
    },
    /** The outcome for bytes this file already recognised, without reading them again. */
    seen(sha256: string | undefined) {
      return sha256 === undefined ? undefined : results.get(sha256);
    },
    /** Under the `images` rules, whether the file has reached its cap and every new unit is `limit`. */
    get full() {
      return full();
    },
    get available() {
      return available;
    },
    get used() {
      return used;
    },
  };
}

/**
 * The one entry point for recognising the units of a file, used by chat, tasks and, through
 * `readKnowledgeSegments`, Knowledge: the cache, deduplication, concurrency, the per-file cap and per-unit credit
 * failures. The recognizer is bound by the host to the requester who pays and the model that reads. Outcomes are in
 * unit order.
 */
export async function recognise(
  units: readonly RecognitionUnit[],
  options: KnowledgeRecognitionOptions & { recognizer: MediaRecognizer },
): Promise<RecognitionOutcome[]> {
  const recognition = fileRecognition(options.recognizer, options);
  return Promise.all(units.map(unit => recognition.recognise(unit)));
}

async function recognizeMedia(
  input: KnowledgeParseInput,
  extraction: KnowledgeExtraction,
  options: KnowledgeRecognitionOptions,
  sandbox: KnowledgeParserSandbox,
): Promise<MediaOutcome> {
  const { recognizer, signal } = options;
  const recognized: MediaOutcome['recognized'] = new Map();
  const gaps: CoverageGap[] = [];
  const gap = (item: MediaItem, reason: CoverageGap['reason']) =>
    gaps.push({ kind: 'image', reason, location: item.location, label: label(item) });
  let failed = 0;
  if (!extraction.media.length) return { recognized, gaps, failed };
  if (!recognizer) {
    for (const item of extraction.media) gap(item, 'recognition-unavailable');
    return { recognized, gaps, failed };
  }

  const recognition = fileRecognition(recognizer, options);
  const settle = (item: MediaItem, result: RecognitionOutcome) => {
    if (result.kind === 'failed') failed += 1;
    else if (result.kind === 'recognized') recognized.set(item.id, result);
    else gap(item, result.kind);
  };

  // Identical stored media is recognized once; rendered pages are deduplicated after rendering.
  const queue = [...extraction.media];
  const pending: Promise<void>[] = [];
  let failure: unknown;
  while (queue.length && failure === undefined) {
    if (!recognition.available) {
      for (const item of queue.splice(0)) gap(item, 'recognition-unavailable');
      break;
    }
    if (recognition.full) {
      // Media past the cap is never read; a repeat of media already recognised keeps its outcome.
      for (const item of queue.splice(0)) {
        const seen = recognition.seen(item.sha256);
        if (seen)
          pending.push(
            seen.then(
              value => settle(item, value),
              () => undefined,
            ),
          );
        else gap(item, 'limit');
      }
      break;
    }
    const batch = queue.splice(0, mediaLimits.batchItems);
    const { header, media } = await sandbox.readMedia(
      input,
      batch.map(({ id, kind, ref }) => ({ id, kind, ref })),
      signal ? { signal } : {},
    );
    const bytesById = new Map(media.map(entry => [entry.id, entry]));
    const items = new Map(batch.map(item => [item.id, item]));
    const deferred: MediaItem[] = [];
    for (const entry of header.items) {
      const item = items.get(entry.id);
      if (!item) continue;
      items.delete(entry.id);
      if (entry.status === 'deferred') deferred.push(item);
      else if (entry.status === 'too-small') continue;
      else if (entry.status === 'too-large') gap(item, 'limit');
      else if (entry.status === 'unsupported') gap(item, 'unsupported-media');
      else {
        const bytes = bytesById.get(item.id);
        if (!bytes) throw new KnowledgeParseError('malformed', { reason: 'invalid-output' });
        pending.push(
          recognition
            .recognise({
              kind: item.kind,
              mediaType: bytes.mediaType,
              bytes: bytes.bytes,
              width: bytes.width,
              height: bytes.height,
              alt: item.alt,
              ...(item.sha256 ? { sha256: item.sha256 } : {}),
            })
            .then(
              value => settle(item, value),
              error => {
                failure ??= error;
              },
            ),
        );
      }
    }
    if (items.size) throw new KnowledgeParseError('malformed', { reason: 'invalid-output' });
    if (deferred.length === batch.length) throw new KnowledgeParseError('malformed', { reason: 'invalid-output' });
    queue.unshift(...deferred);
  }
  await Promise.all(pending);
  if (failure !== undefined) throw failure;
  return recognition.used ? { recognized, gaps, failed, used: recognizer } : { recognized, gaps, failed };
}

function createLimit(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function label(item: MediaItem): string {
  const alt = item.alt.replace(/\s+/g, ' ').trim();
  if (alt) return alt.length > 512 ? `${alt.slice(0, 511)}…` : alt;
  return item.kind === 'page' ? 'Page image' : 'Image';
}

/** Model output is untrusted text: no control characters, placeholders or unbalanced code fences. */
function clean(text: string): string {
  let value = stripPlaceholderMarkers(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .normalize('NFC')
    .trim();
  const fences = value.split('\n').filter(line => /^ {0,3}(`{3,}|~{3,})/.test(line)).length;
  if (fences % 2) value += '\n```';
  return value;
}

/** Recognised text as Markdown; `labelled` starts it with `[Recognised image]` so readers can tell it from file text. */
export function renderRecognition(
  item: Pick<MediaItem, 'kind' | 'alt'>,
  result: Extract<MediaRecognition, { kind: 'recognized' }>,
  { labelled = false }: { labelled?: boolean } = {},
): string {
  const body = recognitionMarkdown(item, result);
  return labelled ? `${recognisedLabel}\n${body}` : body;
}

function recognitionMarkdown(
  item: Pick<MediaItem, 'kind' | 'alt'>,
  result: Extract<MediaRecognition, { kind: 'recognized' }>,
): string {
  const text = clean(result.text);
  const description = clean(result.description).replace(/\s*\n\s*/g, ' ');
  if (item.kind === 'page')
    return [text, description && `**Image description:** ${description}`].filter(Boolean).join('\n\n');
  // An embedded image must not restructure the document around it.
  const body = text.replace(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '**$1**');
  const alt = clean(item.alt).replace(/\s*\n\s*/g, ' ');
  return [
    alt && `**Image:** ${alt}`,
    description && `**Image description:** ${description}`,
    body && `**Text in image:**\n\n${body}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/\n{3,}/g, '\n\n');
}
