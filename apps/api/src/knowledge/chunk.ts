export interface ChunkOptions {
  /** Max characters per chunk. */
  size?: number;
  /** Characters of overlap carried between consecutive chunks. */
  overlap?: number;
}

export interface TextChunk {
  index: number;
  content: string;
}

const DEFAULT_SIZE = 800;
const DEFAULT_OVERLAP = 100;

/**
 * Fixed-window chunker with overlap (KN-V1 chunking, V1 choice). Deterministic and
 * pure — splits plain text into ~`size`-char windows that overlap by `overlap` chars
 * so a match near a boundary is still recallable. Whitespace-only input yields no
 * chunks; text shorter than a window yields a single trimmed chunk.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const size = Math.max(1, opts.size ?? DEFAULT_SIZE);
  const overlap = Math.max(0, Math.min(opts.overlap ?? DEFAULT_OVERLAP, size - 1));
  const step = size - overlap; // ≥ 1, so the loop always advances

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= size) return [{ index: 0, content: trimmed }];

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < trimmed.length) {
    chunks.push({ index, content: trimmed.slice(start, start + size) });
    index += 1;
    if (start + size >= trimmed.length) break;
    start += step;
  }
  return chunks;
}
