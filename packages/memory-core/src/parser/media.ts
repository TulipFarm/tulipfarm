import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { checkArchive } from './archive.js';
import { KnowledgeParseError } from './contracts.js';
import type { KnowledgeParseInput } from './contracts.js';
import { detectInput, loadPdf } from './convert.js';
import { mediaLimits } from './media-contracts.js';
import type { MediaBatchHeader, MediaItem, MediaRef, RecognizableMediaType } from './media-contracts.js';
import { sniffImage } from './image-sniff.js';
import { rtfPictureData, scanRtfMedia } from './rtf.js';

export type MediaRequest = Pick<MediaItem, 'id' | 'kind' | 'ref'>;
type Status = MediaBatchHeader['items'][number];
type Normalized =
  | { status: 'ready'; mediaType: RecognizableMediaType; width: number; height: number; bytes: Buffer }
  | { status: 'too-small' | 'too-large' | 'unsupported' };

/** Decoded pixels allowed for one image, so a small file can't expand into gigabytes of canvas. */
const maximumPixels = 40_000_000;
/** Longest side of an image that has to be re-encoded. */
const reencodeSide = 2048;

type Canvas = typeof import('@napi-rs/canvas');
type Surface = import('@napi-rs/canvas').Canvas;
type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfTask = ReturnType<Pdfjs['getDocument']>;
type RenderParameters = Parameters<Awaited<ReturnType<Awaited<PdfTask['promise']>['getPage']>>['render']>[0];

/**
 * Reads, decodes and normalizes the requested media of one document. Ready items carry bytes only while the batch
 * stays within `mediaLimits.batchBytes`; the first ready item is always included and later ones are deferred.
 */
export async function readMedia(
  input: KnowledgeParseInput,
  items: MediaRequest[],
): Promise<{ header: MediaBatchHeader; bytes: Buffer[] }> {
  if (items.length > mediaLimits.batchItems) throw new KnowledgeParseError('resource-limited');
  const source = new MediaSource(input);
  const header: MediaBatchHeader = { kind: 'media', items: [] };
  const bytes: Buffer[] = [];
  let total = 0;
  for (const item of items) {
    const result = await source.read(item.ref);
    if (result.status !== 'ready') {
      header.items.push({ id: item.id, status: result.status });
      continue;
    }
    if (bytes.length && total + result.bytes.length > mediaLimits.batchBytes) {
      header.items.push({ id: item.id, status: 'deferred' });
      continue;
    }
    total += result.bytes.length;
    bytes.push(result.bytes);
    header.items.push({
      id: item.id,
      status: 'ready',
      mediaType: result.mediaType,
      width: result.width,
      height: result.height,
      byteLength: result.bytes.length,
    } satisfies Status);
  }
  await source.close();
  return { header, bytes };
}

class MediaSource {
  #parts?: Map<string, Buffer>;
  #rtf?: { text: string; pictures: ReturnType<typeof scanRtfMedia>[number]['pictures'] };
  #pdf?: Promise<PdfTask>;
  readonly #bytes: Buffer;

  constructor(input: KnowledgeParseInput) {
    this.#bytes = detectInput(input).bytes;
  }

  async read(ref: MediaRef): Promise<Normalized> {
    if (ref.kind === 'pdf-page') return this.#render(ref.page);
    if (ref.kind === 'file') return normalizeImage(this.#bytes);
    let raw: Buffer | undefined;
    if (ref.kind === 'part') {
      this.#parts ??= checkArchive(this.#bytes);
      raw = this.#parts.get(ref.path);
    } else {
      if (!this.#rtf) {
        const text = this.#bytes.toString('latin1');
        this.#rtf = { text, pictures: scanRtfMedia(text).flatMap(group => group.pictures) };
      }
      const picture = this.#rtf.pictures.find(value => value.index === ref.index);
      raw = picture ? rtfPictureData(this.#rtf.text, picture) : undefined;
    }
    if (!raw?.length) return { status: 'unsupported' };
    return normalizeImage(raw);
  }

  async #render(page: number): Promise<Normalized> {
    const canvas = await import('@napi-rs/canvas');
    this.#pdf ??= openPdf(this.#bytes);
    const document = await (
      await this.#pdf
    ).promise.catch(() => {
      throw new KnowledgeParseError('malformed');
    });
    if (page > document.numPages) return { status: 'unsupported' };
    const proxy = await document.getPage(page);
    try {
      const base = proxy.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height);
      if (!(longest > 0)) return { status: 'unsupported' };
      const viewport = proxy.getViewport({ scale: mediaLimits.renderSide / longest });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const surface: Surface = canvas.createCanvas(width, height);
      const context = surface.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      // pdf.js renders onto @napi-rs/canvas in Node; its types only name the DOM canvas.
      await proxy.render({
        canvas: surface,
        canvasContext: context,
        viewport,
        annotationMode: 0,
      } as unknown as RenderParameters).promise;
      return encodeWithin(canvas, surface, width, height, 'image/jpeg');
    } finally {
      proxy.cleanup();
    }
  }

  async close(): Promise<void> {
    if (this.#pdf) await (await this.#pdf.catch(() => undefined))?.destroy();
  }
}

async function openPdf(bytes: Buffer) {
  // pdf-lib re-saves PDFs whose header isn't at byte zero, as extraction does, so page numbers agree.
  const data = bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    ? new Uint8Array(bytes)
    : await (await loadPdf(bytes)).save({ useObjectStreams: false });
  const pdfjs: Pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  return pdfjs.getDocument({
    data,
    // The parser runs with --jitless, which rules out WebAssembly decoders.
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
    standardFontDataUrl: `${join(root, 'standard_fonts')}/`,
    cMapUrl: `${join(root, 'cmaps')}/`,
    cMapPacked: true,
  });
}

/** SVG is rasterized only when it can't pull in entities, scripts or external resources. */
function safeSvg(text: string): boolean {
  if (/<!DOCTYPE|<!ENTITY|<script|<foreignObject|<\?xml-stylesheet/i.test(text)) return false;
  for (const match of text.matchAll(/(?:href|src)\s*=\s*["']\s*([^"']*)["']/gi)) {
    const value = match[1] ?? '';
    if (!value.startsWith('#') && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) return false;
  }
  for (const match of text.matchAll(/url\(\s*["']?\s*([^)"'\s]*)/gi)) {
    if (!(match[1] ?? '').startsWith('#')) return false;
  }
  return !/@import/i.test(text);
}

export async function normalizeImage(raw: Buffer): Promise<Normalized> {
  const sniffed = sniffImage(raw);
  if (sniffed.type === 'other') return { status: 'unsupported' };
  if (sniffed.type === 'svg' && !safeSvg(raw.toString('utf8'))) return { status: 'unsupported' };
  if (sniffed.width !== undefined && sniffed.height !== undefined) {
    if (!sniffed.width || !sniffed.height) return { status: 'unsupported' };
    if (sniffed.width < mediaLimits.minimumSide && sniffed.height < mediaLimits.minimumSide)
      return { status: 'too-small' };
    if (sniffed.width * sniffed.height > maximumPixels) return { status: 'too-large' };
  } else if (sniffed.type !== 'svg') return { status: 'unsupported' };
  const canvas = await import('@napi-rs/canvas');
  let image: InstanceType<Canvas['Image']>;
  try {
    image = await canvas.loadImage(raw);
  } catch {
    return { status: 'unsupported' };
  }
  let { width, height } = image;
  if (sniffed.type === 'svg' && (!width || !height)) return { status: 'unsupported' };
  if (!width || !height) return { status: 'unsupported' };
  if (width < mediaLimits.minimumSide && height < mediaLimits.minimumSide) return { status: 'too-small' };
  const mediaType = ({ png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const)[
    sniffed.type as 'png'
  ];
  if (mediaType && raw.length <= mediaLimits.imageBytes)
    return { status: 'ready', mediaType, width, height, bytes: raw };
  if (width * height > maximumPixels) return { status: 'too-large' };
  const scale = Math.min(1, reencodeSide / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  const surface: Surface = canvas.createCanvas(width, height);
  const context = surface.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return encodeWithin(canvas, surface, width, height, sniffed.type === 'svg' ? 'image/png' : 'image/jpeg');
}

/** Encodes a canvas, shrinking it until it fits `mediaLimits.imageBytes`. */
async function encodeWithin(
  canvas: Canvas,
  surface: Surface,
  width: number,
  height: number,
  preferred: 'image/jpeg' | 'image/png',
): Promise<Normalized> {
  let current: Surface = surface;
  let size = { width, height };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes =
      preferred === 'image/png' && attempt === 0 ? await current.encode('png') : await current.encode('jpeg', 80);
    if (bytes.length <= mediaLimits.imageBytes)
      return {
        status: 'ready',
        mediaType: preferred === 'image/png' && attempt === 0 ? 'image/png' : 'image/jpeg',
        ...size,
        bytes,
      };
    const next = {
      width: Math.max(1, Math.floor(size.width * 0.75)),
      height: Math.max(1, Math.floor(size.height * 0.75)),
    };
    if (next.width < mediaLimits.minimumSide && next.height < mediaLimits.minimumSide) break;
    const smaller: Surface = canvas.createCanvas(next.width, next.height);
    const context = smaller.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, next.width, next.height);
    context.drawImage(current, 0, 0, next.width, next.height);
    current = smaller;
    size = next;
  }
  return { status: 'too-large' };
}
