import { createRequire } from 'node:module';
import type { Format } from '@firecrawl/anydoc/index.js';
import { knowledgeLimits } from '../document-contracts.js';
import { checkArchive } from './archive.js';
import { normalization, normalizeMarkdown } from './chunks.js';
import { MediaCollector, gapLabels } from './collector.js';
import { KnowledgeParseError, parseFailure } from './contracts.js';
import type { KnowledgeParseInput } from './contracts.js';
import { stripPlaceholderMarkers } from './media-contracts.js';
import type { ExtractionSegment, KnowledgeExtraction, KnowledgeLocation } from './media-contracts.js';
import { checkOffice } from './office.js';
import type { OfficePackage } from './office.js';
import { readSheetDrawing, rewritePresentation, rewriteWord, rewriteWorkbook } from './ooxml.js';
import { checkOpenDocument, rewriteOpenDocument } from './opendocument.js';
import { checkPdf } from './pdf.js';
import { checkRtf, scanRtfMedia } from './rtf.js';
import { appendBlocks, escapeMarkdown, storeZip } from './tokens.js';
import { readXmlSource, rewriteXml, xmlName } from './xml.js';
import type { XmlElement } from './xml.js';

const textExtensions = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'cs',
  'sh',
  'sql',
  'toml',
  'ini',
  'log',
]);
const textMediaTypes = new Set(['text/plain', 'text/markdown', 'application/json', 'application/xml', 'text/xml']);
const nativeExtensions = new Set([
  'doc',
  'docx',
  'docm',
  'odt',
  'pdf',
  'ppt',
  'pptx',
  'pptm',
  'pps',
  'ppsx',
  'rtf',
  'epub',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'ods',
  'odp',
  'csv',
]);
const nativeMediaTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/rtf',
  'text/rtf',
  'text/csv',
  'application/epub+zip',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const anydocVersion = '0.2.4';

type Anydoc = typeof import('@firecrawl/anydoc/index.js');
interface Draft {
  key: string;
  location: KnowledgeLocation;
  markdown: string;
}

export function detectInput(input: KnowledgeParseInput) {
  const bytes = Buffer.from(input.bytes);
  const extension = input.filename.split('.').at(-1)?.toLowerCase() ?? '';
  const mediaType = input.mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  const zip = bytes.length >= 4 && (bytes.readUInt32LE(0) === 0x04034b50 || bytes.readUInt32LE(0) === 0x06054b50);
  const ole = bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const rtf = bytes.subarray(0, 5).toString('ascii') === '{\\rtf';
  return { bytes, extension, mediaType, zip, ole, rtf };
}

/** Loads a PDF the way extraction does, so media reads see the same pages. */
export async function loadPdf(bytes: Buffer) {
  const { PDFDocument } = await import('pdf-lib');
  try {
    const document = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
      ignoreEncryption: true,
    });
    if (document.isEncrypted) throw new KnowledgeParseError('encrypted');
    const pages = document.getPageCount();
    if (pages > knowledgeLimits.pages) throw new KnowledgeParseError('resource-limited');
    if (!pages) throw new KnowledgeParseError('malformed');
    return document;
  } catch (error) {
    if (error instanceof KnowledgeParseError) throw error;
    throw new KnowledgeParseError('malformed');
  }
}

function checkAnydoc(): void {
  const require = createRequire(import.meta.url);
  const metadata: unknown = require('@firecrawl/anydoc/package.json');
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== anydocVersion) {
    throw new KnowledgeParseError('resource-limited');
  }
}

function imageBased(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'needsOcr' ||
      (error.code === 'unsupported' &&
        /^unsupported input: PDF has no extractable text \(ImageBased, \d+ pages\)$/.test(error.message)))
  );
}

/** Markdown from AnyDoc without characters that could forge placeholders. */
async function markdownOf(anydoc: Anydoc, bytes: Buffer, format?: Format | null): Promise<string> {
  return stripPlaceholderMarkers(await anydoc.toMarkdownBytes(bytes, format));
}

/** Text with media, segmented by page, slide or sheet where the format has them. */
// With rawTextFallback, a document the converter rejects as unsupported or malformed is still indexed from its raw
// text when the bytes are plain UTF-8 text, so it stays searchable. The extraction records the original failure.
export async function extractDocument(input: KnowledgeParseInput): Promise<KnowledgeExtraction> {
  try {
    return await extractNative(input);
  } catch (error) {
    if (!input.rawTextFallback) throw error;
    const failure = parseFailure(error);
    if (failure !== 'unsupported' && failure !== 'malformed') throw error;
    const text = rawText(Buffer.from(input.bytes));
    if (text === undefined) throw error;
    return {
      engine: 'text',
      version: '1',
      normalization,
      pages: 0,
      segments: [{ location: { kind: 'passage' }, markdown: normalizeMarkdown(stripPlaceholderMarkers(text)) }],
      media: [],
      gaps: [],
      fallback: failure,
    };
  }
}

function rawText(bytes: Buffer): string | undefined {
  if (
    bytes.includes(Buffer.from('%PDF-')) ||
    bytes.includes(Buffer.from('PK\x03\x04')) ||
    bytes.includes(Buffer.from('d0cf11e0a1b11ae1', 'hex')) ||
    bytes.subarray(0, 5).toString('ascii') === '{\\rtf'
  )
    return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  // Control characters other than tab, line breaks and form feed mean binary data, not text.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return undefined;
  return text.trim() ? text : undefined;
}

async function extractNative(input: KnowledgeParseInput): Promise<KnowledgeExtraction> {
  const { bytes, extension, mediaType, zip, ole, rtf } = detectInput(input);
  const anydoc = await import('@firecrawl/anydoc/index.js');
  const collector = new MediaCollector();
  let pkg: OfficePackage | undefined;
  let parts: Map<string, Buffer> | undefined;
  if (zip) {
    parts = checkArchive(bytes);
    pkg = checkOffice(parts);
    checkOpenDocument(parts);
  }
  const detected = anydoc.formatFromBytes(bytes);
  const native =
    detected !== null || zip || ole || rtf || nativeExtensions.has(extension) || nativeMediaTypes.has(mediaType);
  if (!native) {
    if (!textExtensions.has(extension) && !textMediaTypes.has(mediaType)) throw new KnowledgeParseError('unsupported');
    if (
      bytes.includes(Buffer.from('%PDF-')) ||
      bytes.includes(Buffer.from('PK\x03\x04')) ||
      bytes.includes(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
    )
      throw new KnowledgeParseError('unsupported');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new KnowledgeParseError('malformed');
    }
    return {
      engine: 'text',
      version: '1',
      normalization,
      pages: 0,
      segments: [{ location: { kind: 'passage' }, markdown: normalizeMarkdown(stripPlaceholderMarkers(text)) }],
      media: [],
      gaps: [],
    };
  }
  checkAnydoc();
  let drafts: Draft[];
  let pages = 0;
  const passage = async (source: Buffer, format?: Format | null): Promise<Draft[]> => [
    { key: 'passage', location: { kind: 'passage' }, markdown: await markdownOf(anydoc, source, format) },
  ];
  if (detected === 'pdf') {
    const result = await extractPdf(anydoc, bytes, collector);
    drafts = result.drafts;
    pages = result.pages;
  } else if (rtf || detected === 'rtf') {
    drafts = await passage(rewriteRtf(bytes, collector));
  } else if (parts && pkg?.main?.root === 'w:document') {
    const appendix = rewriteWord(pkg, parts, collector);
    drafts = await passage(storeZip(parts));
    for (const draft of drafts)
      draft.markdown = appendix
        ? `${draft.markdown.trimEnd()}\n\n${stripPlaceholderMarkers(appendix)}\n`
        : draft.markdown;
  } else if (parts && pkg?.main?.root === 'p:presentation') {
    drafts = await extractPresentation(anydoc, pkg, parts, collector);
  } else if (parts && pkg?.main?.root === 's:workbook') {
    drafts = await extractWorkbook(anydoc, pkg, parts, collector);
  } else if (parts) {
    const boundaries = rewriteOpenDocument(parts, collector);
    const markdown = await markdownOf(anydoc, storeZip(parts));
    drafts = boundaries.length
      ? splitBoundaries(markdown, boundaries, collector)
      : [{ key: 'passage', location: { kind: 'passage' }, markdown }];
  } else {
    drafts = await passage(
      bytes,
      !ole && (extension === 'csv' || mediaType === 'text/csv') ? anydoc.formatFromExtension('csv') : undefined,
    );
    if (ole && !collector.gaps.length) {
      // AnyDoc 0.2.4 keeps pictures of legacy binary documents as assets but places none of them in Markdown.
      const document = await anydoc.toDocument(bytes).catch(() => undefined);
      if (document?.assets.some(asset => asset.mediaType.startsWith('image/')))
        collector.gap('image', 'unsupported-media', gapLabels.legacyImages);
    }
  }
  const seen = new Set<string>();
  let total = 0;
  const segments: ExtractionSegment[] = drafts.map(draft => {
    let markdown = collector.tokens.place(draft.markdown, seen);
    markdown = appendBlocks(markdown, collector.tokens.missing(collector.bySegment.get(draft.key) ?? [], seen));
    markdown = tidy(markdown);
    total += Buffer.byteLength(markdown);
    if (total > knowledgeLimits.normalizedBytes) throw new KnowledgeParseError('resource-limited');
    return { location: draft.location, markdown };
  });
  const segment = segments[0];
  // Tokens of segments that were merged away still belong somewhere.
  const rest = collector.tokens.missing([...collector.bySegment.values()].flat(), seen);
  if (rest.length && segment) segment.markdown = tidy(appendBlocks(segment.markdown, rest));
  if (!segments.length) segments.push({ location: { kind: 'passage' }, markdown: '' });
  return {
    engine: 'anydoc',
    version: anydocVersion,
    normalization,
    pages,
    segments,
    media: collector.media,
    gaps: collector.gaps,
  };
}

function tidy(markdown: string): string {
  const normalized = markdown
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  if (/\p{Cc}/u.test(normalized.replace(/[\n\t]/g, ''))) throw new KnowledgeParseError('malformed');
  if (!normalized.trim()) return '';
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function splitBoundaries(
  markdown: string,
  boundaries: { boundary: string; key: string; location: KnowledgeLocation }[],
  collector: MediaCollector,
): Draft[] {
  const lines = markdown.split('\n');
  const positions = boundaries.map(({ boundary }) => lines.indexOf(boundary));
  const ordered = positions.every(
    (position, index) =>
      position !== -1 &&
      (index === 0 || position > (positions[index - 1] ?? 0)) &&
      lines.lastIndexOf(lines[position] ?? '') === position,
  );
  if (!ordered) {
    collector.flatten();
    const tokens = new Set(boundaries.map(({ boundary }) => boundary));
    return [
      {
        key: 'passage',
        location: { kind: 'passage' },
        markdown: lines.filter(line => !tokens.has(line)).join('\n'),
      },
    ];
  }
  return boundaries.map(({ key, location }, index) => {
    const start = (positions[index] ?? 0) + 1;
    const end = positions[index + 1] ?? lines.length;
    const before = index === 0 ? lines.slice(0, positions[0] ?? 0) : [];
    return { key, location, markdown: [...before, ...lines.slice(start, end)].join('\n') };
  });
}

async function extractPresentation(
  anydoc: Anydoc,
  pkg: OfficePackage,
  parts: Map<string, Buffer>,
  collector: MediaCollector,
): Promise<Draft[]> {
  const slides = rewritePresentation(pkg, parts, collector);
  if (slides.length > knowledgeLimits.pages) throw new KnowledgeParseError('resource-limited');
  const markdown = await markdownOf(anydoc, storeZip(parts));
  return splitBoundaries(
    markdown,
    slides.map(({ boundary }, index) => ({
      boundary,
      key: `slide:${index + 1}`,
      location: { kind: 'slide', slide: index + 1 },
    })),
    collector,
  );
}

/** Each sheet is converted on its own so its cells, heading and drawing stay together. */
async function extractWorkbook(
  anydoc: Anydoc,
  pkg: OfficePackage,
  parts: Map<string, Buffer>,
  collector: MediaCollector,
): Promise<Draft[]> {
  const main = pkg.main;
  const workbook = main ? parts.get(main.path) : undefined;
  if (!main || !workbook) throw new KnowledgeParseError('malformed');
  rewriteWorkbook(pkg, parts);
  const { text, root } = readXmlSource(workbook);
  const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const entries = root.children
    .filter(node => node.name === xmlName(sheetNs, 'sheets'))
    .flatMap(node => node.children.filter(entry => entry.name === xmlName(sheetNs, 'sheet')));
  if (entries.length > knowledgeLimits.pages) throw new KnowledgeParseError('resource-limited');
  const rels = pkg.relationships.get(main.path);
  const drafts: Draft[] = [];
  for (const [index, entry] of entries.entries()) {
    const name = entry.attributes.get('|name') ?? '';
    const key = `sheet:${index + 1}`;
    const location: KnowledgeLocation = { kind: 'sheet', sheet: index + 1, name: name.slice(0, 256) };
    collector.at(key, location);
    const target = rels?.get(
      entry.attributes.get(xmlName('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')) ?? '',
    )?.target;
    if (/^(?:hidden|veryHidden)$/.test(entry.attributes.get('|state') ?? '')) {
      collector.gap('other', 'unsupported-media', gapLabels.hiddenSheet);
      continue;
    }
    const sheet = target ? parts.get(target) : undefined;
    const sheetRoot = sheet ? readXmlSource(sheet).root : undefined;
    if (sheetRoot && hasHiddenCells(sheetRoot, sheetNs)) {
      collector.gap('other', 'unsupported-media', gapLabels.hiddenCells);
    }
    if (sheetRoot && hasUncachedFormula(sheetRoot, sheetNs)) {
      collector.gap('other', 'unsupported-media', gapLabels.uncachedFormula);
    }
    const single = new Map(parts);
    single.set(
      main.path,
      rewriteXml(
        text,
        entries.filter(other => other !== entry).map(other => ({ start: other.start, end: other.end, value: '' })),
      ),
    );
    const cells = await markdownOf(anydoc, storeZip(single));
    if (target) readSheetDrawing(pkg, parts, target, collector);
    drafts.push({
      key,
      location,
      markdown: `## ${escapeMarkdown(stripPlaceholderMarkers(name))}\n\n${cells}`,
    });
  }
  return drafts;
}

const columnNumber = (reference: string) =>
  [...(/^[A-Z]+/.exec(reference)?.[0] ?? '')].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

/** True when a worksheet has a formula without a saved value, which AnyDoc shows as an empty cell. */
function hasUncachedFormula(root: XmlElement, sheetNs: string): boolean {
  return [...walkCells(root, sheetNs)].some(
    cell =>
      cell.children.some(value => value.name === xmlName(sheetNs, 'f')) &&
      !cell.children.some(value => value.name === xmlName(sheetNs, 'v') && value.text.trim()),
  );
}

function* walkCells(root: XmlElement, sheetNs: string): Generator<XmlElement> {
  for (const data of root.children.filter(node => node.name === xmlName(sheetNs, 'sheetData')))
    for (const row of data.children.filter(node => node.name === xmlName(sheetNs, 'row')))
      yield* row.children.filter(node => node.name === xmlName(sheetNs, 'c'));
}

/** True when a worksheet's hidden rows or columns hold a value, which AnyDoc leaves out. */
function hasHiddenCells(root: XmlElement, sheetNs: string): boolean {
  const hidden = (node: XmlElement) => /^(?:1|true)$/.test(node.attributes.get('|hidden') ?? '');
  const child = (node: XmlElement, name: string) =>
    node.children.filter(value => value.name === xmlName(sheetNs, name));
  const columns = child(root, 'cols')
    .flatMap(node => child(node, 'col'))
    .filter(hidden)
    .map(node => [Number(node.attributes.get('|min')), Number(node.attributes.get('|max'))] as const);
  return child(root, 'sheetData')
    .flatMap(node => child(node, 'row'))
    .some(row =>
      child(row, 'c').some(cell => {
        if (!cell.children.some(value => value.name === xmlName(sheetNs, 'v') || value.name === xmlName(sheetNs, 'is')))
          return false;
        if (hidden(row)) return true;
        const column = columnNumber(cell.attributes.get('|r') ?? '');
        return columns.some(([min, max]) => column >= min && column <= max);
      }),
    );
}

function rewriteRtf(bytes: Buffer, collector: MediaCollector): Buffer {
  const text = bytes.toString('latin1');
  const groups = scanRtfMedia(text);
  let result = '';
  let position = 0;
  for (const group of groups) {
    const tokens =
      group.kind === 'alternate'
        ? []
        : group.pictures.length
          ? group.pictures.map(picture =>
              picture.format === 'unknown'
                ? collector.gapToken('image', gapLabels.drawing)
                : collector.image({ kind: 'rtf-picture', index: picture.index }, ''),
            )
          : [
              collector.gapToken(
                group.kind === 'object' ? 'object' : 'image',
                group.kind === 'object' ? gapLabels.object : gapLabels.drawing,
              ),
            ];
    result += `${text.slice(position, group.start)}${tokens.length ? ` ${tokens.join(' ')} ` : ''}`;
    position = group.end;
  }
  result += text.slice(position);
  const rewritten = Buffer.from(result, 'latin1');
  checkRtf(rewritten);
  return rewritten;
}

/**
 * One segment per page. Pages that paint images become rendered page media whose fallback is the page's native
 * text; other pages keep their text. AnyDoc has no page markers, so a multi-page PDF is converted page by page.
 */
async function extractPdf(
  anydoc: Anydoc,
  bytes: Buffer,
  collector: MediaCollector,
): Promise<{ drafts: Draft[]; pages: number }> {
  const document = await loadPdf(bytes);
  const pages = document.getPageCount();
  let imagePages: Set<number>;
  try {
    imagePages = checkPdf(document);
  } catch (error) {
    if (error instanceof KnowledgeParseError) throw error;
    throw new KnowledgeParseError('malformed');
  }
  const { PDFDict, PDFDocument, PDFName, PDFRawStream } = await import('pdf-lib');
  const text = async (source: Buffer) => {
    try {
      return await markdownOf(anydoc, source);
    } catch (error) {
      if (imageBased(error)) return '';
      throw error;
    }
  };
  const drafts: Draft[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const painted = imagePages.has(page);
    let source: Buffer;
    if (pages === 1 && !painted) {
      // AnyDoc 0.2.4 detects prefixed PDFs but its converter reports zero pages unless the header starts at byte zero.
      source = bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
        ? bytes
        : Buffer.from(await document.save({ useObjectStreams: false }));
    } else {
      const single = await PDFDocument.create({ updateMetadata: false });
      const [copy] = await single.copyPages(document, [page - 1]);
      if (!copy) throw new KnowledgeParseError('malformed');
      single.addPage(copy);
      if (painted) {
        // AnyDoc refuses pages an image dominates, so the fallback text is read with images and soft masks blanked.
        const empty = single.context.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] });
        for (const [reference, object] of single.context.enumerateIndirectObjects()) {
          if (object instanceof PDFRawStream) {
            if (object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) single.context.assign(reference, empty);
          } else if (object instanceof PDFDict && object.has(PDFName.of('SMask')))
            object.set(PDFName.of('SMask'), PDFName.of('None'));
        }
      }
      source = Buffer.from(await single.save({ useObjectStreams: false }));
    }
    const location: KnowledgeLocation = { kind: 'page', page };
    collector.at(`page:${page}`, location);
    const markdown = await text(source);
    drafts.push({
      key: `page:${page}`,
      location,
      markdown: painted ? collector.item({ kind: 'pdf-page', page }, '', undefined, 'page', markdown.trim()) : markdown,
    });
  }
  return { drafts, pages };
}
