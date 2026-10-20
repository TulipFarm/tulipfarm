import { createRequire } from 'node:module';
import { knowledgeLimits } from '../document-contracts.js';
import { checkArchive } from './archive.js';
import { checkOffice } from './office.js';
import { checkOpenDocument } from './opendocument.js';
import { checkPdf } from './pdf.js';
import { checkRtf } from './rtf.js';
import { chunkMarkdown, normalizeMarkdown } from './chunks.js';
import { KnowledgeParseError } from './contracts.js';
import type { KnowledgeParseInput, KnowledgeParseResult } from './contracts.js';

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

export async function convertDocument(input: KnowledgeParseInput): Promise<KnowledgeParseResult> {
  const bytes = Buffer.from(input.bytes);
  const extension = input.filename.split('.').at(-1)?.toLowerCase() ?? '';
  const mediaType = input.mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  const zip = bytes.length >= 4 && (bytes.readUInt32LE(0) === 0x04034b50 || bytes.readUInt32LE(0) === 0x06054b50);
  const ole = bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const rtf = bytes.subarray(0, 5).toString('ascii') === '{\\rtf';
  let worksheetNames: string[] = [];
  if (zip) {
    const parts = checkArchive(bytes);
    worksheetNames = checkOffice(parts);
    checkOpenDocument(parts);
  }
  const { formatFromBytes, formatFromExtension, toMarkdownBytes } = await import('@firecrawl/anydoc/index.js');
  const detected = formatFromBytes(bytes);
  if (rtf || detected === 'rtf') checkRtf(bytes);
  const pdf = detected === 'pdf';
  const native =
    detected !== null || zip || ole || rtf || nativeExtensions.has(extension) || nativeMediaTypes.has(mediaType);
  let markdown: string;
  let nativeBytes = bytes;
  let pages = 0;
  if (native) {
    const require = createRequire(import.meta.url);
    const metadata: unknown = require('@firecrawl/anydoc/package.json');
    if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || metadata.version !== '0.2.4') {
      throw new KnowledgeParseError('resource-limited');
    }
    if (pdf) {
      const { PDFDocument } = await import('pdf-lib');
      try {
        const document = await PDFDocument.load(bytes, {
          updateMetadata: false,
          throwOnInvalidObject: true,
          ignoreEncryption: true,
        });
        if (document.isEncrypted) throw new KnowledgeParseError('encrypted');
        pages = document.getPageCount();
        if (pages > knowledgeLimits.pages) throw new KnowledgeParseError('resource-limited');
        checkPdf(document);
        // AnyDoc 0.2.4 detects prefixed PDFs but its converter reports zero pages unless the header starts at byte zero.
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
          nativeBytes = Buffer.from(await document.save({ useObjectStreams: false }));
      } catch (error) {
        if (error instanceof KnowledgeParseError) throw error;
        throw new KnowledgeParseError('malformed');
      }
      if (!pages) throw new KnowledgeParseError('malformed');
    }
    try {
      markdown = await toMarkdownBytes(
        nativeBytes,
        !pdf && !zip && !ole && !rtf && (extension === 'csv' || mediaType === 'text/csv')
          ? formatFromExtension('csv')
          : undefined,
      );
      const [worksheetName] = worksheetNames;
      if (worksheetNames.length === 1 && worksheetName !== undefined) {
        const name = worksheetName.replace(/[\\`*_{}[\]<>()#+.!|~-]/g, '\\$&');
        markdown = `## ${name}\n\n${markdown}`;
      }
    } catch (error) {
      // 0.2.4 reports some image-dominated PDFs as unsupported rather than needsOcr.
      if (
        pdf &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'unsupported' &&
        /^unsupported input: PDF has no extractable text \(ImageBased, \d+ pages\)$/.test(error.message)
      ) {
        throw new KnowledgeParseError('ocr-required');
      }
      throw error;
    }
  } else if (textExtensions.has(extension) || textMediaTypes.has(mediaType)) {
    if (
      bytes.includes(Buffer.from('%PDF-')) ||
      bytes.includes(Buffer.from('PK\x03\x04')) ||
      bytes.includes(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
    )
      throw new KnowledgeParseError('unsupported');
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new KnowledgeParseError('malformed');
    }
  } else throw new KnowledgeParseError('unsupported');
  markdown = normalizeMarkdown(markdown);
  const { chunks, tokens } = chunkMarkdown(markdown);
  const engine = native ? 'anydoc' : 'text';
  const version = native ? '0.2.4' : '1';
  const normalization = 'nfc-lf-v1-cl100k_base-800-100';
  return {
    markdown,
    pages,
    tokens,
    chunks,
    profile: { id: `${engine}-${version}-${normalization}`, engine, version, normalization, ocr: 'disabled' },
  };
}
