import { KnowledgeParseError } from './contracts.js';

export interface XmlElement {
  name: string;
  attributes: Map<string, string>;
  children: XmlElement[];
  text: string;
  /** Qualified name as written in the source, such as `w:r`. */
  raw: string;
  /** Offsets of the element's start and end in the decoded source text. */
  start: number;
  end: number;
}

export function xmlName(namespace: string, local: string): string {
  return `${namespace}|${local}`;
}

export function readXml(bytes: Buffer): XmlElement {
  return readXmlSource(bytes).root;
}

export function decodeXml(bytes: Buffer): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/** Parses XML and keeps the decoded text so callers can rewrite elements by offset. */
export function readXmlSource(bytes: Buffer): { text: string; root: XmlElement } {
  const text = decodeXml(bytes);
  const stack: { raw: string; element: XmlElement; namespaces: Map<string, string> }[] = [];
  let root: XmlElement | undefined;
  let position = 0;
  let count = 0;
  const token =
    /<!--[^]*?-->|<\?[^]*?\?>|<!\[CDATA\[[^]*?\]\]>|<\/[A-Za-z_][\w.:-]*\s*>|<[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/y;
  while (position < text.length) {
    token.lastIndex = position;
    const match = token.exec(text);
    if (!match) malformed();
    const value = match[0];
    position = token.lastIndex;
    if (value.startsWith('<!--') || value.startsWith('<?')) continue;
    if (value.startsWith('<![CDATA[')) {
      const parent = stack.at(-1);
      if (!parent) malformed();
      parent.element.text += value.slice(9, -3);
      continue;
    }
    if (!value.startsWith('<')) {
      if (!stack.length && value.trim()) malformed();
      const decoded = entities(value);
      const parent = stack.at(-1);
      if (parent) parent.element.text += decoded;
      continue;
    }
    if (value.startsWith('</')) {
      const open = stack.pop();
      if (open?.raw !== value.slice(2, -1).trim()) malformed();
      open.element.end = position;
      continue;
    }
    if (++count > 250_000 || stack.length > 256) throw new KnowledgeParseError('resource-limited');
    const raw = /^<([^\s/>]+)/.exec(value)?.[1];
    if (!raw) malformed();
    const parent = stack.at(-1);
    const namespaces = new Map(parent?.namespaces ?? [['xml', 'http://www.w3.org/XML/1998/namespace']]);
    const attributes = new Map<string, string>();
    for (const attr of value.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = attr[1];
      if (!key || attributes.has(key)) malformed();
      const content = entities(attr[2] ?? attr[3] ?? '');
      attributes.set(key, content);
      if (key === 'xmlns') namespaces.set('', content);
      else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), content);
    }
    const qualify = (name: string, attribute = false) => {
      const pieces = name.split(':');
      if (pieces.length > 2) malformed();
      const prefix = pieces.length === 2 ? (pieces[0] ?? '') : '';
      const namespace = !prefix && attribute ? '' : (namespaces.get(prefix) ?? '');
      if (prefix && !namespace) malformed();
      return xmlName(
        namespace
          .replace('http://purl.oclc.org/ooxml/', 'http://schemas.openxmlformats.org/')
          .replace('/wordprocessingml/main', '/wordprocessingml/2006/main')
          .replace('/spreadsheetml/main', '/spreadsheetml/2006/main')
          .replace('/presentationml/main', '/presentationml/2006/main')
          .replace('/officeDocument/relationships', '/officeDocument/2006/relationships'),
        pieces.at(-1) ?? '',
      );
    };
    const element: XmlElement = {
      name: qualify(raw),
      attributes: new Map(),
      children: [],
      text: '',
      raw,
      start: position - value.length,
      end: position,
    };
    for (const [name, content] of attributes) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const key = qualify(name, true);
      if (element.attributes.has(key)) malformed();
      element.attributes.set(key, content);
    }
    if (parent) parent.element.children.push(element);
    else {
      if (root) malformed();
      root = element;
    }
    if (!value.endsWith('/>')) stack.push({ raw, element, namespaces });
  }
  if (!root || stack.length) malformed();
  return { text, root };
}

/** Applies non-overlapping replacements of source ranges; a range inside another replaced range is dropped. */
export function rewriteXml(text: string, edits: { start: number; end: number; value: string }[]): Buffer {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  let result = '';
  let position = 0;
  for (const edit of sorted) {
    if (edit.start < position) continue;
    result += text.slice(position, edit.start) + edit.value;
    position = edit.end;
  }
  result += text.slice(position);
  // The rewrite is UTF-8, so a declared UTF-16 encoding must go.
  return Buffer.from(
    result.replace(/^\uFEFF/, '').replace(/^(<\?xml[^>]*?)\s+encoding\s*=\s*(["'])[^"']*\2/, '$1'),
    'utf8',
  );
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`);
}

function entities(text: string): string {
  return text.replace(/&([^;]*);|&/g, (whole: string, entity: string | undefined) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    if (!entity || !/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) malformed();
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) malformed();
    return String.fromCodePoint(code);
  });
}

function malformed(): never {
  throw new KnowledgeParseError('malformed');
}
