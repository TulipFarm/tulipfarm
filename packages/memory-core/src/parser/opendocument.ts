import { KnowledgeParseError } from './contracts.js';
import { readXml, xmlName } from './xml.js';
import type { XmlElement } from './xml.js';

const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const style = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const fo = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
const manifest = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
const odt = 'application/vnd.oasis.opendocument.text';
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
    { children: inline, attributes: new Map([[xmlName(text, 'outline-level'), /^[1-6]$/]]), text: true },
  ],
  [xmlName(text, 'p'), { children: [...inline, xmlName(office, 'annotation')], attributes: new Map(), text: true }],
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
        [xmlName(manifest, 'full-path'), /^(?:\/|content\.xml)$/],
        [xmlName(manifest, 'media-type'), /^(?:application\/vnd\.oasis\.opendocument\.text|text\/xml)$/],
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
    if (!['mimetype', 'content.xml', 'META-INF/manifest.xml'].includes(path)) unsupported();
  }
  const styles = new Set<string>();
  const references: string[] = [];
  function inspect(node: XmlElement): void {
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

function unsupported(): never {
  throw new KnowledgeParseError('unsupported');
}
