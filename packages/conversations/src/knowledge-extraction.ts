import { parseKnowledgeDocument } from '@tulipfarm/knowledge/parser';

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

export async function extractKnowledge(filename: string, bytes: Uint8Array): Promise<string> {
  const extension = knowledgeFileExtension(filename);
  if (!knowledgeTextExtensions.has(extension) && extension !== 'pdf' && extension !== 'docx') {
    throw new KnowledgeExtractionError('unsupported-file');
  }
  if (bytes.byteLength > 10 * 1024 * 1024) throw new KnowledgeExtractionError('unreadable-file');
  if (knowledgeTextExtensions.has(extension)) {
    try {
      return readableKnowledgeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
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
    return readableKnowledgeText(result.markdown);
  } catch {
    throw new KnowledgeExtractionError('unreadable-file');
  }
}
