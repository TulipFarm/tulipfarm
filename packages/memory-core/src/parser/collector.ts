import { createHash } from 'node:crypto';
import { KnowledgeParseError } from './contracts.js';
import { mediaLimits, mediaPlaceholder, stripPlaceholderMarkers } from './media-contracts.js';
import type { CoverageGap, KnowledgeLocation, MediaItem, MediaRef } from './media-contracts.js';
import { TokenSet, escapeMarkdown } from './tokens.js';

export type GapKind = CoverageGap['kind'];

/** Model-facing gap labels are fixed strings so documents can't place instructions in them. */
export const gapLabels = Object.freeze({
  linkedImage: 'Linked image',
  video: 'Video',
  audio: 'Audio',
  object: 'Embedded object',
  drawing: 'Unsupported drawing',
  chart: 'Chart without data',
  legacyImages: 'Images in legacy format',
  pdfImages: 'Images in PDF pages',
  hiddenText: 'Hidden text',
  hiddenCells: 'Hidden rows or columns',
  hiddenSheet: 'Hidden sheet',
  uncachedFormula: 'Formula without a saved value',
  embeddedDocument: 'Embedded document',
});

function truncate(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = Buffer.from(value).subarray(0, bytes).toString('utf8');
  while (Buffer.byteLength(result) > bytes || result.endsWith('\uFFFD')) result = result.slice(0, -1);
  return result;
}

export function cleanAlt(value: string | undefined): string {
  return truncate(
    stripPlaceholderMarkers(value ?? '')
      .replace(/[^\P{Cc}\n\t]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .normalize('NFC'),
    mediaLimits.altBytes,
  );
}

/** Collects media items, coverage gaps and their tokens while a document is rewritten. */
export class MediaCollector {
  readonly tokens = new TokenSet();
  readonly media: MediaItem[] = [];
  readonly gaps: CoverageGap[] = [];
  /** Tokens created for each segment key, in creation order, so lost tokens are appended to their own segment. */
  readonly bySegment = new Map<string, string[]>();
  #segment = 'passage';
  #location: KnowledgeLocation = { kind: 'passage' };

  at(key: string, location: KnowledgeLocation): void {
    this.#segment = key;
    this.#location = location;
  }

  get location(): KnowledgeLocation {
    return this.#location;
  }

  #token(block: string): string {
    const token = this.tokens.create(block);
    const list = this.bySegment.get(this.#segment) ?? [];
    list.push(token);
    this.bySegment.set(this.#segment, list);
    return token;
  }

  /** Adds a media item and returns the token marking its position. */
  image(ref: MediaRef, alt: string | undefined, bytes?: Buffer, kind: MediaItem['kind'] = 'image'): string {
    return this.#token(this.item(ref, alt, bytes, kind));
  }

  /** Adds a media item and returns its placeholder, for callers that place it themselves. */
  item(
    ref: MediaRef,
    alt: string | undefined,
    bytes?: Buffer,
    kind: MediaItem['kind'] = 'image',
    fallback?: string,
  ): string {
    if (this.media.length >= 10_000) {
      this.gap('image', 'limit', 'Image');
      return '';
    }
    const id = `m${this.media.length + 1}`;
    const description = cleanAlt(alt);
    this.media.push({
      id,
      kind,
      ref,
      location: this.#location,
      alt: description,
      fallback: truncate(fallback ?? (description ? escapeMarkdown(description) : ''), mediaLimits.fallbackBytes),
      ...(bytes ? { sha256: createHash('sha256').update(bytes).digest('hex') } : {}),
    });
    return mediaPlaceholder(id);
  }

  /** Records a coverage gap; the returned token only marks where the media was. */
  gapToken(kind: GapKind, label: string): string {
    this.gap(kind, 'unsupported-media', label);
    return this.#token('');
  }

  gap(kind: GapKind, reason: CoverageGap['reason'], label: string): void {
    if (this.gaps.length >= 10_000) throw new KnowledgeParseError('resource-limited');
    this.gaps.push({ kind, reason, location: this.#location, label });
  }

  /** Generated Markdown (chart data, diagram text) placed as its own block. */
  block(markdown: string): string {
    return this.#token(stripPlaceholderMarkers(markdown));
  }

  /** Moves everything to one passage when segment boundaries could not be recovered. */
  flatten(): void {
    for (const item of this.media) item.location = { kind: 'passage' };
    for (const gap of this.gaps) gap.location = { kind: 'passage' };
    const all = [...this.bySegment.values()].flat();
    this.bySegment.clear();
    this.bySegment.set('passage', all);
  }
}
