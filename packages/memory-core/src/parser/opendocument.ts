import { walk } from './charts.js';
import { gapLabels } from './collector.js';
import type { MediaCollector } from './collector.js';
import { KnowledgeParseError } from './contracts.js';
import type { KnowledgeLocation } from './media-contracts.js';
import { escapeMarkdown } from './tokens.js';
import { readXml, readXmlSource, rewriteXml, xmlName } from './xml.js';
import type { XmlElement } from './xml.js';

const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const style = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const fo = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
const manifest = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
const draw = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const svg = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
const xlink = 'http://www.w3.org/1999/xlink';
const odt = 'application/vnd.oasis.opendocument.text';
const frame = xmlName(draw, 'frame');
/** Package parts that embedded frames may refer to. They are read only as media, never parsed as ODF. */
const mediaPart = /^(?:Pictures|ObjectReplacements)\/[^/]+$|^Object \d+\/(?:[^/]+\/)?[^/]+$/;
type Rule = { children: string[]; attributes: Map<string, RegExp>; text?: boolean };
const name = /^[A-Za-z_][\w.-]*$/;
const inline = [xmlName(text, 'span')];
const paragraphs = [xmlName(text, 'h'), xmlName(text, 'p')];
const grammar = new Map<string, Rule>([
  [
    xmlName(office, 'document-content'),
    {
      children: [xmlName(office, 'automatic-styles'), xmlName(office, 'body')],
      attributes: new Map([[xmlName(office, 'version'), /^1\.[23]$/]]),
    },
  ],
  [xmlName(office, 'automatic-styles'), { children: [xmlName(style, 'style')], attributes: new Map() }],
  [xmlName(office, 'body'), { children: [xmlName(office, 'text')], attributes: new Map() }],
  [xmlName(office, 'text'), { children: paragraphs, attributes: new Map() }],
  [
    xmlName(text, 'h'),
    { children: [...inline, frame], attributes: new Map([[xmlName(text, 'outline-level'), /^[1-6]$/]]), text: true },
  ],
  [
    xmlName(text, 'p'),
    { children: [...inline, frame, xmlName(office, 'annotation')], attributes: new Map(), text: true },
  ],
  [xmlName(office, 'annotation'), { children: [xmlName(text, 'p')], attributes: new Map() }],
  [xmlName(text, 'span'), { children: [], attributes: new Map([[xmlName(text, 'style-name'), name]]), text: true }],
  [
    xmlName(style, 'style'),
    {
      children: [xmlName(style, 'text-properties')],
      attributes: new Map([
        [xmlName(style, 'name'), name],
        [xmlName(style, 'family'), /^text$/],
      ]),
    },
  ],
  [
    xmlName(style, 'text-properties'),
    {
      children: [],
      attributes: new Map([
        [xmlName(fo, 'font-weight'), /^(?:normal|bold)$/],
        [xmlName(fo, 'font-style'), /^(?:normal|italic)$/],
        [xmlName(style, 'text-line-through-style'), /^(?:none|solid)$/],
        [xmlName(style, 'text-line-through-type'), /^single$/],
      ]),
    },
  ],
  [
    xmlName(manifest, 'manifest'),
    { children: [xmlName(manifest, 'file-entry')], attributes: new Map([[xmlName(manifest, 'version'), /^1\.[23]$/]]) },
  ],
  [
    xmlName(manifest, 'file-entry'),
    {
      children: [],
      attributes: new Map([
        [
          xmlName(manifest, 'full-path'),
          /^(?:\/|content\.xml|(?:Pictures|ObjectReplacements)\/[^/]+|Object \d+\/(?:[^/]+\/?)?(?:[^/]+)?)$/,
        ],
        [xmlName(manifest, 'media-type'), /^(?:[\w.+-]+\/[\w.+-]+)?$/],
      ]),
    },
  ],
]);

export function checkOpenDocument(parts: Map<string, Buffer>): void {
  const content = parts.get('content.xml');
  const declared = parts.get('mimetype')?.toString('utf8') === odt;
  const root = content ? readXml(content) : undefined;
  if (!declared && root?.name !== xmlName(office, 'document-content')) return;
  if (!root || root.name !== xmlName(office, 'document-content')) unsupported();
  if (!declared) unsupported();
  for (const path of parts.keys()) {
    if (!['mimetype', 'content.xml', 'META-INF/manifest.xml'].includes(path) && !mediaPart.test(path)) unsupported();
  }
  const styles = new Set<string>();
  const references: string[] = [];
  function inspect(node: XmlElement): void {
    // Frames hold pictures, objects and drawings, which become media or coverage gaps rather than text.
    if (node.name === frame) return;
    const rule = grammar.get(node.name);
    if (!rule || (!rule.text && node.text.trim())) unsupported();
    for (const [key, value] of node.attributes) {
      if (!rule.attributes.get(key)?.test(value)) unsupported();
    }
    if (node.name === xmlName(style, 'style')) {
      const id = node.attributes.get(xmlName(style, 'name'));
      if (!id || styles.has(id) || node.attributes.get(xmlName(style, 'family')) !== 'text' || node.children.length > 1)
        unsupported();
      styles.add(id);
    }
    if (node.name === xmlName(text, 'span')) {
      const id = node.attributes.get(xmlName(text, 'style-name'));
      if (id) references.push(id);
    }
    if (
      node.name === xmlName(office, 'annotation') &&
      (node.children.length !== 1 || node.children.some(child => child.children.length || child.attributes.size))
    )
      unsupported();
    for (const child of node.children) {
      if (!rule.children.includes(child.name)) unsupported();
      inspect(child);
    }
  }
  inspect(root);
  if (references.some(id => !styles.has(id))) unsupported();
  const bodies = root.children.filter(node => node.name === xmlName(office, 'body'));
  if (
    bodies.length !== 1 ||
    bodies[0]?.children.length !== 1 ||
    root.children.filter(node => node.name === xmlName(office, 'automatic-styles')).length > 1
  )
    unsupported();
  const metadata = parts.get('META-INF/manifest.xml');
  if (metadata) {
    const tree = readXml(metadata);
    if (tree.name !== xmlName(manifest, 'manifest')) unsupported();
    inspect(tree);
  }
}

function textOf(node: XmlElement): string {
  return [...walk(node)]
    .map(value => value.text)
    .join('')
    .replace(/[^\P{Cc}\t]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Replaces each frame in a qualified ODF text document with tokens for its picture, embedded object, media or
 * text box. Text documents have no slide or sheet boundaries, so no boundaries are returned.
 */
export function rewriteOpenDocument(
  parts: Map<string, Buffer>,
  collector: MediaCollector,
): { boundary: string; key: string; location: KnowledgeLocation }[] {
  const content = parts.get('content.xml');
  if (!content || parts.get('mimetype')?.toString('utf8') !== odt) return [];
  const { text: source, root } = readXmlSource(content);
  const edits: { start: number; end: number; value: string }[] = [];
  const visit = (node: XmlElement): void => {
    if (node.name !== frame) {
      for (const child of node.children) visit(child);
      return;
    }
    const described = (local: string) => {
      const child = node.children.find(value => value.name === xmlName(svg, local));
      return child ? textOf(child) : '';
    };
    const alt = described('desc') || described('title');
    const tokens: string[] = [];
    const image = node.children.find(child => child.name === xmlName(draw, 'image'));
    const object = node.children.find(
      child => child.name === xmlName(draw, 'object') || child.name === xmlName(draw, 'object-ole'),
    );
    const plugin = node.children.find(child => child.name === xmlName(draw, 'plugin'));
    const box = node.children.find(child => child.name === xmlName(draw, 'text-box'));
    if (plugin) {
      const audio = /^audio\//i.test(plugin.attributes.get(xmlName(draw, 'mime-type')) ?? '');
      tokens.push(collector.gapToken(audio ? 'audio' : 'video', audio ? gapLabels.audio : gapLabels.video));
    } else if (image) {
      const href = (image.attributes.get(xmlName(xlink, 'href')) ?? '').replace(/^\.\//, '');
      const bytes = parts.get(href);
      if (bytes && mediaPart.test(href)) tokens.push(collector.image({ kind: 'part', path: href }, alt, bytes));
      else if (href) tokens.push(collector.gapToken('image', gapLabels.linkedImage));
      else tokens.push(collector.gapToken('image', gapLabels.drawing));
    } else if (object) tokens.push(collector.gapToken('object', gapLabels.object));
    else if (box) {
      const paragraphs = [...walk(box)]
        .filter(child => paragraphNames.has(child.name))
        .map(textOf)
        .filter(Boolean)
        .map(escapeMarkdown);
      if (paragraphs.length) tokens.push(collector.block(paragraphs.join('\n\n')));
    } else tokens.push(collector.gapToken('other', gapLabels.drawing));
    edits.push({ start: node.start, end: node.end, value: tokens.length ? ` ${tokens.join(' ')} ` : '' });
  };
  visit(root);
  if (edits.length) parts.set('content.xml', rewriteXml(source, edits));
  return [];
}

const paragraphNames = new Set(paragraphs);

function unsupported(): never {
  throw new KnowledgeParseError('unsupported');
}
