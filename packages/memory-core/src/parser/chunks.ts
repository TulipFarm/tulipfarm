import { getEncoding } from 'js-tiktoken';
import { knowledgeLimits } from '../document-contracts.js';
import { KnowledgeParseError, parserLimits } from './contracts.js';
import type { KnowledgeChunk } from './contracts.js';

const tokenizer = getEncoding('cl100k_base');
export function countTokens(text: string): number {
  return tokenizer.encode(text, [], []).length;
}

export function normalizeMarkdown(text: string): string {
  const normalized = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC');
  if (/\p{Cc}/u.test(normalized.replace(/[\n\t]/g, '')) || !normalized.trim()) {
    throw new KnowledgeParseError('malformed');
  }
  if (Buffer.byteLength(normalized) > knowledgeLimits.normalizedBytes)
    throw new KnowledgeParseError('resource-limited');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

interface Section {
  heading: string;
  prefix: string;
  lines: string[];
}

export function chunkMarkdown(markdown: string): { chunks: KnowledgeChunk[]; tokens: number } {
  if (countTokens(markdown) > knowledgeLimits.tokens) throw new KnowledgeParseError('resource-limited');
  const sections: Section[] = [];
  const headings: { level: number; text: string }[] = [];
  let current: Section = { heading: '', prefix: '', lines: [] };
  let fence: { marker: string; length: number } | undefined;
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter?.[1]) {
      const marker = delimiter[1][0] ?? '`';
      if (!fence) fence = { marker, length: delimiter[1].length };
      else if (fence.marker === marker && delimiter[1].length >= fence.length && !delimiter[2]?.trim())
        fence = undefined;
      current.lines.push(line);
      continue;
    }
    const atx = !fence ? /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    const underline = !fence && line.trim() && /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1] ?? '');
    const title = atx?.[2] ?? (underline ? line.trim() : undefined);
    if (title) {
      if (current.lines.some(value => value.trim()) || current.prefix) sections.push(current);
      const level = atx?.[1]?.length ?? (underline && underline[1]?.startsWith('=') ? 1 : 2);
      while (headings.length && (headings.at(-1)?.level ?? 0) >= level) headings.pop();
      headings.push({ level, text: title });
      current = {
        heading: headings.map(item => item.text).join(' > '),
        prefix: headings.map(item => `${'#'.repeat(item.level)} ${item.text}`).join('\n'),
        lines: [],
      };
      if (underline) index += 1;
    } else current.lines.push(line);
  }
  if (current.lines.some(value => value.trim()) || current.prefix) sections.push(current);

  const chunks: KnowledgeChunk[] = [];
  let tokens = 0;
  const emit = (section: Section, body: string) => {
    const text = [section.prefix, body.trim()].filter(Boolean).join('\n\n');
    const measured = countTokens(text);
    tokens += measured;
    if (
      !text ||
      measured > parserLimits.targetTokens ||
      Buffer.byteLength(text) > knowledgeLimits.chunkBytes ||
      tokens > knowledgeLimits.tokens ||
      chunks.length >= knowledgeLimits.chunksPerRevision
    ) {
      throw new KnowledgeParseError('resource-limited');
    }
    chunks.push({ heading: section.heading, text, tokens: measured, offset: { kind: 'passage' } });
  };

  for (const section of sections) {
    if (section.heading.length > 2048 || countTokens(section.prefix) > parserLimits.targetTokens - 32) {
      throw new KnowledgeParseError('resource-limited');
    }
    let prose: string[] = [];
    let emitted = false;
    const flush = () => {
      const text = prose.join('\n').trim();
      prose = [];
      if (!text) return;
      splitProse(text, section.prefix, part => emit(section, part));
      emitted = true;
    };
    let inFence = false;
    for (let index = 0; index < section.lines.length; index += 1) {
      const line = section.lines[index] ?? '';
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      const separator = section.lines[index + 1] ?? '';
      if (!inFence && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) {
        flush();
        const header = `${line}\n${separator}`;
        let table = header;
        let hasRows = false;
        index += 2;
        for (; index < section.lines.length; index += 1) {
          const row = section.lines[index] ?? '';
          if (!row.trim() || !row.includes('|')) break;
          const candidate = `${table}\n${row}`;
          hasRows = true;
          if (!tableFits(section.prefix, candidate)) {
            if (table !== header) emit(section, table);
            table = header;
            if (tableFits(section.prefix, `${header}\n${row}`)) table = `${header}\n${row}`;
            else splitTableRow(row, header, section.prefix, part => emit(section, part));
          } else table = candidate;
        }
        if (table !== header || !hasRows) emit(section, table);
        emitted = true;
        index -= 1;
      } else prose.push(line);
    }
    flush();
    if (!emitted && section.prefix) emit(section, '');
  }
  if (!chunks.length) throw new KnowledgeParseError('malformed');
  return { chunks, tokens };
}

/** Chunks each located segment separately so every passage keeps the page, slide or sheet it came from. */
export function chunkSegments(segments: readonly { location: KnowledgeChunk['offset']; markdown: string }[]): {
  chunks: KnowledgeChunk[];
  tokens: number;
} {
  const chunks: KnowledgeChunk[] = [];
  let tokens = 0;
  for (const segment of segments) {
    if (!segment.markdown.trim()) continue;
    const result = chunkMarkdown(segment.markdown);
    tokens += result.tokens;
    if (tokens > knowledgeLimits.tokens || chunks.length + result.chunks.length > knowledgeLimits.chunksPerRevision)
      throw new KnowledgeParseError('resource-limited');
    for (const chunk of result.chunks) chunks.push({ ...chunk, offset: segment.location });
  }
  if (!chunks.length) throw new KnowledgeParseError('malformed');
  return { chunks, tokens };
}

function joinPrefix(prefix: string, text: string): string {
  return prefix ? `${prefix}\n\n${text}` : text;
}

function tableFits(prefix: string, table: string): boolean {
  const text = joinPrefix(prefix, table);
  return countTokens(text) <= parserLimits.targetTokens && Buffer.byteLength(text) <= knowledgeLimits.chunkBytes;
}

function splitTableRow(row: string, header: string, prefix: string, emit: (text: string) => void): void {
  const cells: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '|' && !escaped) {
      cells.push(row.slice(start, index));
      start = index + 1;
    }
    escaped = character === '\\' && !escaped;
  }
  cells.push(row.slice(start));
  if (!cells[0]?.trim()) cells.shift();
  if (!cells.at(-1)?.trim()) cells.pop();
  const render = (parts: string[]) => `${header}\n|${parts.join('|')}|`;
  const context = cells.map(() => '');
  let contextTokens = 0;
  for (const [index, cell] of cells.entries()) {
    const tokens = countTokens(cell);
    if (contextTokens + tokens > parserLimits.overlapTokens) continue;
    context[index] = cell;
    const text = joinPrefix(prefix, render(context));
    if (countTokens(text) > parserLimits.targetTokens - 32 || Buffer.byteLength(text) > knowledgeLimits.chunkBytes)
      context[index] = '';
    else contextTokens += tokens;
  }
  let parts = [...context];
  let populated = false;
  const flush = () => {
    if (populated) emit(render(parts));
    parts = [...context];
    populated = false;
  };
  if (cells.every((cell, index) => cell === context[index])) {
    emit(render(parts));
    return;
  }
  for (const [index, cell] of cells.entries()) {
    if (cell === context[index]) continue;
    let offset = 0;
    while (offset < cell.length) {
      const remaining = cell.slice(offset);
      const fits = (part: string) => {
        parts[index] = part;
        return tableFits(prefix, render(parts));
      };
      let end = fittingPrefix(remaining, fits);
      // Never split an escaped delimiter from its backslash.
      while (
        end > 0 &&
        (((/\\+$/.exec(remaining.slice(0, end))?.[0].length ?? 0) % 2 === 1 && end < remaining.length) ||
          !fits(remaining.slice(0, end)))
      ) {
        end -= 1;
        if (/[\uD800-\uDBFF]/.test(remaining[end - 1] ?? '')) end -= 1;
      }
      parts[index] = remaining.slice(0, end);
      if (end === 0) {
        if (!populated) throw new KnowledgeParseError('resource-limited');
        flush();
        continue;
      }
      populated = true;
      offset += end;
      if (offset < cell.length) flush();
    }
  }
  flush();
}

function splitProse(text: string, prefix: string, emit: (text: string) => void): void {
  let start = 0;
  while (start < text.length) {
    const remaining = text.slice(start);
    let end = fittingPrefix(remaining, part => countTokens(joinPrefix(prefix, part)) <= parserLimits.targetTokens);
    if (end <= 0) throw new KnowledgeParseError('resource-limited');
    if (end < remaining.length) {
      const boundary = Math.max(
        remaining.lastIndexOf('\n\n', end),
        remaining.lastIndexOf('. ', end),
        remaining.lastIndexOf(' ', end),
      );
      if (boundary > end / 2 && boundary < end) end = boundary + 1;
    }
    const part = remaining.slice(0, end);
    emit(part);
    if (start + end >= text.length) break;
    const overlapStart = fittingSuffix(
      part.trimEnd(),
      Math.min(parserLimits.overlapTokens, Math.floor(countTokens(part) / 4)),
    );
    start += Math.max(1, overlapStart);
  }
}

function fittingPrefix(text: string, fits: (part: string) => boolean): number {
  let low = 0;
  let high = Math.min(text.length, knowledgeLimits.chunkBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1] ?? '')) low -= 1;
  return low;
}

function fittingSuffix(text: string, limit: number): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (countTokens(text.slice(middle).trim()) <= limit) high = middle;
    else low = middle + 1;
  }
  if (/[\uDC00-\uDFFF]/.test(text[low] ?? '')) low += 1;
  while (low < text.length && countTokens(text.slice(low).trim()) > limit) low += 1;
  return low;
}
