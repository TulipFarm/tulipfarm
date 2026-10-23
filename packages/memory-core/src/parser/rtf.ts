import { KnowledgeParseError } from './contracts.js';

const toggles = new Set(['b', 'i', 'strike']);
const separators = new Set(['par', 'line', 'tab']);

export function checkRtf(bytes: Buffer): void {
  const text = bytes.toString('latin1');
  if (!/^\{\\rtf1\\ansi(?=[ \\{\r\n])/.test(text)) unsupported();
  let position = '{\\rtf1\\ansi'.length;
  let depth = 1;
  let fontTable = false;
  let colorTable = false;
  while (position < text.length) {
    const character = text[position++];
    if (character === '{') {
      if (text.startsWith('\\fonttbl', position)) {
        if (depth !== 1 || fontTable) unsupported();
        const match = /^\\fonttbl\{\\f0\\fnil(?:\\fcharset0)? Arial;\}\}/.exec(text.slice(position));
        if (!match) unsupported();
        fontTable = true;
        position += match[0].length;
      } else if (text.startsWith('\\colortbl', position)) {
        if (depth !== 1 || colorTable) unsupported();
        const match = /^\\colortbl;(?:\\red(\d{1,3})\\green(\d{1,3})\\blue(\d{1,3});)?\}/.exec(text.slice(position));
        if (!match || match.slice(1).some(value => value !== undefined && Number(value) > 255)) unsupported();
        colorTable = true;
        position += match[0].length;
      } else {
        depth += 1;
        if (depth > 256) throw new KnowledgeParseError('resource-limited');
      }
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (!depth) {
        if (text.slice(position).trim()) malformed();
        return;
      }
      continue;
    }
    if (character !== '\\') {
      if (!character || !/[\x20-\x7e\r\n\t]/.test(character)) unsupported();
      continue;
    }
    const symbol = text[position];
    if (symbol && '\\{}'.includes(symbol)) {
      position += 1;
      continue;
    }
    if (symbol === "'") {
      const hex = text.slice(position + 1, position + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) malformed();
      const code = Number.parseInt(hex, 16);
      if (code < 32 || code > 126) unsupported();
      position += 3;
      continue;
    }
    const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(text.slice(position));
    if (!match) unsupported();
    position += match[0].length;
    const word = match[1] ?? '';
    const parameter = match[2] ?? '';
    if (toggles.has(word) && ['', '0', '1'].includes(parameter)) continue;
    if (separators.has(word) && !parameter) continue;
    if (word === 'deff' && parameter === '0' && depth === 1) continue;
    if (word === 'f' && parameter === '0' && fontTable) continue;
    if (word === 'uc' && parameter === '1') continue;
    if (word === 'u') {
      const code = Number(parameter);
      if (!/^\d+$/.test(parameter) || code < 32 || code > 32767 || text[position] !== '?') unsupported();
      position += 1;
      continue;
    }
    unsupported();
  }
  malformed();
}

function unsupported(): never {
  throw new KnowledgeParseError('unsupported');
}
function malformed(): never {
  throw new KnowledgeParseError('malformed');
}

export interface RtfPicture {
  index: number;
  /** Picture format control word, such as `pngblip` or `emfblip`. */
  format: string;
  start: number;
  end: number;
}

export interface RtfMediaGroup {
  start: number;
  end: number;
  /** Pictures shown for the group; empty for an object without a result picture. */
  pictures: RtfPicture[];
  kind: 'picture' | 'object' | 'alternate';
}

const pictureFormats = /\\(pngblip|jpegblip|emfblip|wmetafile|dibitmap|wbitmap|macpict|pmmetafile)/;

function groupEnd(text: string, start: number): number {
  let depth = 0;
  let position = start;
  while (position < text.length) {
    const character = text[position++];
    if (character === '\\') {
      const binary = /^bin(\d{1,9}) ?/.exec(text.slice(position, position + 16));
      if (binary) position += binary[0].length + Number(binary[1]);
      else position += 1;
    } else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (!depth) return position;
    }
  }
  malformed();
}

/**
 * Finds pictures and objects in RTF. `\shppict` pictures are kept and their `\nonshppict` fallbacks dropped; an
 * object shows its `\result` picture. Picture indexes are stable for the same bytes, so they address media later.
 */
export function scanRtfMedia(text: string): RtfMediaGroup[] {
  const groups: RtfMediaGroup[] = [];
  let index = 0;
  const pictures = (start: number, end: number): RtfPicture[] => {
    const result: RtfPicture[] = [];
    let position = start;
    while ((position = text.indexOf('{\\pict', position)) !== -1 && position < end) {
      const close = groupEnd(text, position);
      const format = pictureFormats.exec(text.slice(position, Math.min(close, position + 4096)))?.[1] ?? 'unknown';
      result.push({ index: index++, format, start: position, end: close });
      position = close;
    }
    return result;
  };
  const pattern = /\{(?:\\\*)?\\(pict|shppict|nonshppict|object)(?![a-zA-Z])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    // Escaped braces such as `\{` are text.
    let slashes = 0;
    while (text[match.index - 1 - slashes] === '\\') slashes += 1;
    if (slashes % 2) continue;
    const start = match.index;
    const end = groupEnd(text, start);
    const kind = match[1];
    if (kind === 'nonshppict') groups.push({ start, end, pictures: [], kind: 'alternate' });
    else if (kind === 'object') {
      const result = text.indexOf('{\\result', start);
      groups.push({ start, end, pictures: result !== -1 && result < end ? pictures(result, end) : [], kind: 'object' });
    } else groups.push({ start, end, pictures: pictures(start, end), kind: 'picture' });
    pattern.lastIndex = end;
    if (groups.length > 100_000) throw new KnowledgeParseError('resource-limited');
  }
  return groups;
}

/** Binary data of a picture group: hexadecimal digits or a `\bin` run after the control words. */
export function rtfPictureData(text: string, picture: RtfPicture): Buffer {
  const body = text.slice(picture.start + 1, picture.end - 1);
  let position = 0;
  const parts: Buffer[] = [];
  let hex = '';
  while (position < body.length) {
    const character = body[position] ?? '';
    if (character === '{') {
      const end = groupEnd(body, position);
      position = end;
      continue;
    }
    if (character === '\\') {
      const binary = /^\\bin(\d{1,9}) ?/.exec(body.slice(position, position + 16));
      if (binary) {
        const start = position + binary[0].length;
        parts.push(Buffer.from(body.slice(start, start + Number(binary[1])), 'latin1'));
        position = start + Number(binary[1]);
        continue;
      }
      const word = /^\\(?:[a-zA-Z]+-?\d* ?|.)/.exec(body.slice(position));
      position += word?.[0].length ?? 1;
      continue;
    }
    if (/[0-9a-fA-F]/.test(character)) hex += character;
    position += 1;
  }
  if (hex.length % 2) hex = hex.slice(0, -1);
  return Buffer.concat([...parts, Buffer.from(hex, 'hex')]);
}
