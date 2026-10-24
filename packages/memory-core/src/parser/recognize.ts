import { createHash } from 'node:crypto';
import { chunkSegments, normalizeMarkdown } from './chunks.js';
import { KnowledgeParseError } from './contracts.js';
import type { KnowledgeParseInput, KnowledgeParseResult } from './contracts.js';
import {
  MediaRecognitionUnavailable,
  mediaLimits,
  mediaRecognitionSchema,
  placeholderPattern,
  recognitionCacheKey,
  stripPlaceholderMarkers,
} from './media-contracts.js';
import type {
  CoverageGap,
  KnowledgeExtraction,
  KnowledgeLocation,
  KnowledgeRecognitionOptions,
  MediaBytes,
  MediaItem,
  MediaRecognition,
  MediaRecognizer,
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
  const extraction = await sandbox.extract(input, signal ? { signal } : {});
  const outcome = await recognizeMedia(input, extraction, recognition, sandbox);
  const byId = new Map(extraction.media.map(item => [item.id, item]));
  const segments = extraction.segments.map(segment => ({
    location: segment.location,
    markdown: tidy(
      segment.markdown.replace(placeholderPattern, (_, id: string) => {
        const item = byId.get(id);
        if (!item) return '';
        const result = outcome.recognized.get(id);
        return result ? renderRecognition(item, result) : item.fallback;
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

interface RecognitionOutcome {
  recognized: Map<string, Extract<MediaRecognition, { kind: 'recognized' }>>;
  gaps: CoverageGap[];
  failed: number;
  /** Set when at least one media item went through the recognizer or its cache. */
  used?: MediaRecognizer;
}

async function recognizeMedia(
  input: KnowledgeParseInput,
  extraction: KnowledgeExtraction,
  { recognizer, cache, signal, failedRecognition = 'throw' }: KnowledgeRecognitionOptions,
  sandbox: KnowledgeParserSandbox,
): Promise<RecognitionOutcome> {
  const recognized: RecognitionOutcome['recognized'] = new Map();
  const gaps: CoverageGap[] = [];
  const gap = (item: MediaItem, reason: CoverageGap['reason']) =>
    gaps.push({ kind: 'image', reason, location: item.location, label: label(item) });
  let failed = 0;
  if (!extraction.media.length) return { recognized, gaps, failed };
  if (!recognizer) {
    for (const item of extraction.media) gap(item, 'recognition-unavailable');
    return { recognized, gaps, failed };
  }

  let used = false;
  let available = true;
  let calls = 0;
  const results = new Map<string, Promise<MediaRecognition | 'failed' | undefined>>();
  const settle = (item: MediaItem, result: MediaRecognition | 'failed' | undefined) => {
    if (result === 'failed') failed += 1;
    else if (!result) gap(item, available ? 'limit' : 'recognition-unavailable');
    else if (result.kind === 'recognized') recognized.set(item.id, result);
    else gap(item, result.kind);
  };
  const recognize = async (item: MediaItem, media: MediaBytes, sha256: string) => {
    const key = recognitionCacheKey(sha256, recognizer);
    const cached = await cache?.get(key);
    if (cached) {
      used = true;
      return mediaRecognitionSchema.parse(cached);
    }
    if (!available || calls >= mediaLimits.recognitionsPerRevision) return undefined;
    calls += 1;
    try {
      const result = mediaRecognitionSchema.parse(
        await recognizer.recognize({
          kind: item.kind,
          mediaType: media.mediaType,
          bytes: media.bytes,
          width: media.width,
          height: media.height,
          alt: item.alt,
          ...(signal ? { signal } : {}),
        }),
      );
      used = true;
      await cache?.set(key, result);
      return result;
    } catch (error) {
      if (error instanceof MediaRecognitionUnavailable) {
        available = false;
        return undefined;
      }
      if (failedRecognition === 'count' && !signal?.aborted) return 'failed' as const;
      throw new KnowledgeParseError('resource-limited', { reason: 'recognition-failed' });
    }
  };

  // Identical stored media is recognized once; rendered pages are deduplicated after rendering.
  const queue = [...extraction.media];
  const pending: Promise<void>[] = [];
  let failure: unknown;
  const limit = createLimit(recognitionConcurrency);
  while (queue.length && failure === undefined) {
    if (!available) {
      for (const item of queue.splice(0)) gap(item, 'recognition-unavailable');
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
        const sha256 = item.sha256 ?? createHash('sha256').update(bytes.bytes).digest('hex');
        let result = results.get(sha256);
        if (!result) {
          result = limit(() => recognize(item, bytes, sha256));
          results.set(sha256, result);
        }
        pending.push(
          result.then(
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
  return used ? { recognized, gaps, failed, used: recognizer } : { recognized, gaps, failed };
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

export function renderRecognition(
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
