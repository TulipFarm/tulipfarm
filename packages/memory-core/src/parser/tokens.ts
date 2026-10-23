import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Media and boundaries are marked in the source with plain alphanumeric tokens that AnyDoc copies verbatim.
 * Each token is then replaced in AnyDoc's Markdown with a block of its own.
 */
export class TokenSet {
  readonly #nonce = randomBytes(6).toString('hex');
  readonly #blocks = new Map<string, string>();
  #count = 0;

  /** Creates a token whose Markdown block is set now or later with `set`. */
  create(block = ''): string {
    const token = `TFMEDIA${this.#nonce}x${this.#count++}TF`;
    this.#blocks.set(token, block);
    return token;
  }

  set(token: string, block: string): void {
    this.#blocks.set(token, block);
  }

  get pattern(): RegExp {
    return new RegExp(`TFMEDIA${this.#nonce}x[0-9]+TF`, 'g');
  }

  has(token: string): boolean {
    return this.#blocks.has(token);
  }

  /**
   * Replaces tokens in Markdown. A token alone on a line becomes its block in place; a token inside a paragraph,
   * table, list or quote is removed and its block is placed after that block. Only the first occurrence of a token
   * counts; tokens that AnyDoc lost are returned so the caller can append their blocks.
   */
  place(markdown: string, seen: Set<string>): string {
    const pattern = this.pattern;
    const output: string[] = [];
    let pending: string[] = [];
    const flush = () => {
      if (!pending.length) return;
      const blocks = pending.filter(Boolean);
      pending = [];
      if (!blocks.length) return;
      if (output.length && output.at(-1) !== '') output.push('');
      output.push(blocks.join('\n\n'), '');
    };
    for (const line of markdown.split('\n')) {
      if (!line.trim()) {
        flush();
        output.push(line);
        continue;
      }
      const found: string[] = [];
      const surrounding = new RegExp(`(\\*{1,3}|_{1,3}|~~)?(${pattern.source})\\1`, 'g');
      let rest = line.replace(surrounding, (_, _marker: string | undefined, token: string) => {
        found.push(token);
        return '';
      });
      if (!found.length) {
        output.push(line);
        continue;
      }
      rest = rest.replace(pattern, token => {
        found.push(token);
        return '';
      });
      const blocks = found.filter(token => !seen.has(token) && this.#blocks.has(token));
      for (const token of blocks) seen.add(token);
      const text = blocks.map(token => this.#blocks.get(token) ?? '');
      if (found.length === 1 && line === found[0]) {
        flush();
        if (text[0]) {
          if (output.length && output.at(-1) !== '') output.push('');
          output.push(text[0]);
        }
        continue;
      }
      if (rest.trim() && !/^[\s>]*$/.test(rest)) output.push(rest.replace(/(\S) {2,}/g, '$1 ').trimEnd());
      pending.push(...text);
    }
    flush();
    return output
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '');
  }

  /** Blocks of the given tokens that were never placed, in creation order. */
  missing(tokens: Iterable<string>, seen: Set<string>): string[] {
    const result: string[] = [];
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      const block = this.#blocks.get(token);
      if (block) result.push(block);
    }
    return result;
  }
}

export function appendBlocks(markdown: string, blocks: string[]): string {
  const extra = blocks.filter(Boolean);
  if (!extra.length) return markdown;
  const base = markdown.trimEnd();
  return `${base ? `${base}\n\n` : ''}${extra.join('\n\n')}\n`;
}

/** Writes an uncompressed ZIP archive, used to hand rewritten packages to AnyDoc. */
export function storeZip(parts: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(header, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((sum, value) => sum + value.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.size, 8);
  end.writeUInt16LE(parts.size, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]<>()#+.!|~-]/g, '\\$&');
}
