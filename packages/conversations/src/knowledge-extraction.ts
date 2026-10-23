import { knowledgeGapLimit, knowledgeLocationOf, type KnowledgeGaps } from '@tulipfarm/memory-core/contracts';
import { parseKnowledgeDocument } from '@tulipfarm/memory-core/parser';

export class KnowledgeExtractionError extends Error {
  readonly code: 'unsupported-file' | 'unreadable-file';
  constructor(code: KnowledgeExtractionError['code']) {
    super(code);
    this.code = code;
  }
}

export const knowledgeTextExtensions = new Set([
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

export function knowledgeFileExtension(filename: string) {
  return filename.split('.').at(-1)?.toLowerCase() ?? '';
}

export function readableKnowledgeText(content: string) {
  if (!content.trim() || content.includes('\0') || Buffer.byteLength(content) > 1048576) {
    throw new KnowledgeExtractionError('unreadable-file');
  }
  return content;
}

/** Readable text of a project file, and the parts of it that could not be read: the count and the first few. */
export type ExtractedKnowledge = { content: string; gaps: KnowledgeGaps | null };

export async function extractKnowledge(filename: string, bytes: Uint8Array): Promise<ExtractedKnowledge> {
  const extension = knowledgeFileExtension(filename);
  if (!knowledgeTextExtensions.has(extension) && extension !== 'pdf' && extension !== 'docx') {
    throw new KnowledgeExtractionError('unsupported-file');
  }
  if (bytes.byteLength > 10 * 1024 * 1024) throw new KnowledgeExtractionError('unreadable-file');
  if (knowledgeTextExtensions.has(extension)) {
    try {
      return { content: readableKnowledgeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), gaps: null };
    } catch {
      throw new KnowledgeExtractionError('unreadable-file');
    }
  }
  try {
    const result = await parseKnowledgeDocument({
      filename,
      bytes,
      mediaType:
        extension === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    if (result.pages > 200) throw new KnowledgeExtractionError('unreadable-file');
    // Project knowledge has no recognizer: it keeps the readable text and records what it could not read.
    const content = readableKnowledgeText(result.markdown);
    if (!result.gaps.length) return { content, gaps: null };
    return {
      content,
      gaps: {
        count: result.gaps.length,
        items: result.gaps.slice(0, knowledgeGapLimit).map(({ kind, reason, location, label }) => {
          const at = knowledgeLocationOf(location);
          return { kind, reason, label, ...(at ? { location: at } : {}) };
        }),
      },
    };
  } catch {
    throw new KnowledgeExtractionError('unreadable-file');
  }
}
