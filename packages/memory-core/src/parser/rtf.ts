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
