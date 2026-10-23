import { KnowledgeParseError } from './contracts.js';
import { chartMarkdown, diagramMarkdown, drawingParagraphs, paragraphsMarkdown, walk } from './charts.js';
import { cleanAlt, gapLabels } from './collector.js';
import type { MediaCollector } from './collector.js';
import type { OfficePackage, Relationship } from './office.js';
import { escapeMarkdown } from './tokens.js';
import { escapeXml, readXmlSource, rewriteXml } from './xml.js';
import type { XmlElement } from './xml.js';

const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wordDrawing = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const sheetDrawing = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const compatibility = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const vml = 'urn:schemas-microsoft-com:vml';
const vmlOffice = 'urn:schemas-microsoft-com:office:office';
const textBoxUri = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const uris = {
  picture: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  diagram: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  table: 'http://schemas.openxmlformats.org/drawingml/2006/table',
  ole: 'http://schemas.openxmlformats.org/presentationml/2006/ole',
};

type Edit = { start: number; end: number; value: string };

function is(node: XmlElement, namespace: string, local: string): boolean {
  return node.name === `${namespace}|${local}`;
}

function localName(node: XmlElement): string {
  return node.name.slice(node.name.lastIndexOf('|') + 1);
}

function attribute(node: XmlElement, namespace: string, local: string): string | undefined {
  return node.attributes.get(`${namespace}|${local}`);
}

function first(node: XmlElement, predicate: (value: XmlElement) => boolean): XmlElement | undefined {
  for (const value of walk(node)) if (predicate(value)) return value;
  return undefined;
}

/**
 * Turns pictures, charts, diagrams, embedded objects and other drawings under one node into tokens. The node's
 * relationships resolve the parts each one refers to.
 */
class DrawingReader {
  constructor(
    private readonly pkg: OfficePackage,
    private readonly parts: Map<string, Buffer>,
    private readonly collector: MediaCollector,
  ) {}

  #rel(owner: string, id: string | undefined): Relationship | undefined {
    return id ? this.pkg.relationships.get(owner)?.get(id) : undefined;
  }

  /** Token for an `a:blip` or VML image reference. */
  picture(owner: string, id: string | undefined, link: string | undefined, alt: string | undefined): string {
    const rel = this.#rel(owner, id);
    if (rel && !rel.external) {
      const bytes = this.parts.get(rel.target);
      if (bytes) return this.collector.image({ kind: 'part', path: rel.target }, alt, bytes);
    }
    if (rel?.external || link) return this.collector.gapToken('image', gapLabels.linkedImage);
    return this.collector.gapToken('image', gapLabels.drawing);
  }

  chart(owner: string, id: string | undefined): string {
    const rel = this.#rel(owner, id);
    const tree = rel && !rel.external ? this.pkg.trees.get(rel.target) : undefined;
    const markdown = tree ? chartMarkdown(tree) : '';
    return markdown ? this.collector.block(markdown) : this.collector.gapToken('other', gapLabels.chart);
  }

  diagram(owner: string, id: string | undefined): string {
    const rel = this.#rel(owner, id);
    const tree = rel && !rel.external ? this.pkg.trees.get(rel.target) : undefined;
    const markdown = tree ? diagramMarkdown(tree) : '';
    return markdown ? this.collector.block(markdown) : this.collector.gapToken('other', gapLabels.drawing);
  }

  /**
   * Tokens for a drawing subtree, in document order. `text` controls whether loose DrawingML text is kept, which
   * callers disable when AnyDoc already renders it.
   */
  read(owner: string, node: XmlElement, alt: string | undefined, text = true): string[] {
    const tokens: string[] = [];
    const visit = (value: XmlElement, inheritedAlt: string | undefined): void => {
      const name = localName(value);
      const properties = value.children
        .find(child => /^nv.*Pr$/.test(localName(child)))
        ?.children.find(child => localName(child) === 'cNvPr');
      const description =
        attribute(value, '', 'descr') ||
        attribute(value, '', 'title') ||
        attribute(value, '', 'alt') ||
        (properties && (attribute(properties, '', 'descr') || attribute(properties, '', 'title'))) ||
        undefined;
      if (name === 'pic') {
        const media = first(
          value,
          child =>
            ['videoFile', 'quickTimeFile', 'webVideoPr', 'audioFile', 'audioCd', 'wavAudioFile'].includes(
              localName(child),
            ) ||
            (localName(child) === 'media' && child.name.includes('powerpoint')),
        );
        if (media) {
          const audio = /audio/i.test(localName(media));
          tokens.push(this.collector.gapToken(audio ? 'audio' : 'video', audio ? gapLabels.audio : gapLabels.video));
          return;
        }
      }
      if (is(value, compatibility, 'AlternateContent')) {
        const choice = value.children.find(child => is(child, compatibility, 'Choice')) ?? value.children[0];
        if (choice) visit(choice, inheritedAlt);
        return;
      }
      if (
        ['videoFile', 'quickTimeFile'].includes(name) ||
        (name === 'media' && value.name.includes('powerpoint')) ||
        name === 'webVideoPr'
      ) {
        tokens.push(this.collector.gapToken('video', gapLabels.video));
        return;
      }
      if (['audioFile', 'audioCd', 'wavAudioFile'].includes(name)) {
        tokens.push(this.collector.gapToken('audio', gapLabels.audio));
        return;
      }
      if (is(value, drawing, 'blip')) {
        tokens.push(
          this.picture(owner, attribute(value, office, 'embed'), attribute(value, office, 'link'), inheritedAlt),
        );
        return;
      }
      if (is(value, vml, 'imagedata')) {
        tokens.push(
          this.picture(
            owner,
            attribute(value, office, 'id') ?? attribute(value, vmlOffice, 'relid'),
            attribute(value, office, 'href'),
            attribute(value, vmlOffice, 'title') || inheritedAlt,
          ),
        );
        return;
      }
      if (is(value, drawing, 'graphicData')) {
        const uri = attribute(value, '', 'uri') ?? '';
        if (uri === uris.chart) {
          const chart = value.children.find(child => localName(child) === 'chart');
          tokens.push(this.chart(owner, chart && attribute(chart, office, 'id')));
          return;
        }
        if (uri === uris.diagram) {
          const ids = value.children.find(child => localName(child) === 'relIds');
          tokens.push(this.diagram(owner, ids && attribute(ids, office, 'dm')));
          return;
        }
        if (uri === uris.ole || value.children.some(child => /ole/i.test(localName(child)))) {
          const before = tokens.length;
          for (const child of value.children) visit(child, inheritedAlt);
          if (tokens.length === before) tokens.push(this.collector.gapToken('object', gapLabels.object));
          return;
        }
        if (uri === uris.table || uri === textBoxUri) {
          if (text) for (const child of value.children) visit(child, inheritedAlt);
          return;
        }
        if (![uris.picture].includes(uri) && !/wordprocessing(Group|Canvas)|group|canvas/i.test(uri)) {
          const before = tokens.length;
          for (const child of value.children) visit(child, inheritedAlt);
          if (tokens.length === before) tokens.push(this.collector.gapToken('other', gapLabels.drawing));
          return;
        }
      }
      if (is(value, word, 'object') || name === 'OLEObject') {
        const before = tokens.length;
        for (const child of value.children) visit(child, inheritedAlt);
        if (tokens.length === before && is(value, word, 'object'))
          tokens.push(this.collector.gapToken('object', gapLabels.object));
        return;
      }
      if (text && (is(value, word, 'txbxContent') || is(value, drawing, 'p'))) {
        const paragraphs = is(value, word, 'txbxContent')
          ? value.children
              .filter(child => is(child, word, 'p'))
              .map(child =>
                [...walk(child)]
                  .filter(item => is(item, word, 't'))
                  .map(item => item.text)
                  .join('')
                  .trim(),
              )
              .filter(Boolean)
          : drawingParagraphs(value);
        if (paragraphs.length) tokens.push(this.collector.block(paragraphsMarkdown(paragraphs)));
        return;
      }
      for (const child of value.children) visit(child, description || inheritedAlt);
    };
    visit(node, alt);
    return tokens;
  }
}

function tokenRun(run: XmlElement, source: string, tokens: string[]): string {
  const prefix = run.raw.includes(':') ? `${run.raw.split(':')[0]}:` : '';
  const properties = run.children.find(child => is(child, word, 'rPr'));
  const rPr = properties ? source.slice(properties.start, properties.end) : '';
  return `</${run.raw}><${run.raw}><${prefix}t xml:space="preserve">${tokens.join(' ')}</${prefix}t></${run.raw}><${run.raw}>${rPr}`;
}

const pageField = /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES)\b/i;

type FieldFrame = { instruction: string; result: boolean; checkbox?: string };

/** Tracks complex fields so only their cached results are read, never their instructions. */
class FieldState {
  readonly #frames: FieldFrame[] = [];
  constructor(private readonly dropPageNumbers: boolean) {}

  /** True while inside an instruction, or a page number result that headers and footers leave out. */
  get dropped(): boolean {
    return this.#frames.some(frame => !frame.result || (this.dropPageNumbers && pageField.test(frame.instruction)));
  }

  /** Updates the state for a field character. Returns the text a legacy checkbox field shows, if any. */
  character(node: XmlElement): string | undefined {
    const type = attribute(node, word, 'fldCharType');
    if (type === 'begin') {
      const box = first(node, value => is(value, word, 'checkBox'));
      const value =
        box &&
        (box.children.find(child => is(child, word, 'checked')) ??
          box.children.find(child => is(child, word, 'default')));
      const checked = value !== undefined && !/^(?:0|false|off)$/.test(attribute(value, word, 'val') ?? '1');
      this.#frames.push({
        instruction: '',
        result: false,
        ...(box ? { checkbox: checked ? '\u2612' : '\u2610' } : {}),
      });
    } else if (type === 'separate') {
      const frame = this.#frames.at(-1);
      if (frame) frame.result = true;
    } else if (type === 'end') {
      const frame = this.#frames.pop();
      if (frame?.checkbox && !frame.result && !this.dropped) return frame.checkbox;
    }
    return undefined;
  }

  instruction(node: XmlElement): void {
    const frame = this.#frames.at(-1);
    if (frame && !frame.result) frame.instruction += node.text;
  }
}

function isHidden(run: XmlElement): boolean {
  const vanish = run.children.find(child => is(child, word, 'rPr'))?.children.find(child => is(child, word, 'vanish'));
  return vanish !== undefined && !/^(?:0|false|off)$/.test(attribute(vanish, word, 'val') ?? '1');
}

/** The plain-text mark for a superscript or subscript run, so `10²` cannot read as `102`. */
function shiftMark(run: XmlElement): string {
  const align = run.children
    .find(child => is(child, word, 'rPr'))
    ?.children.find(child => is(child, word, 'vertAlign'));
  const value = align && attribute(align, word, 'val');
  return value === 'superscript' ? '^' : value === 'subscript' ? '_' : '';
}

/** Symbol-font letters that differ from ASCII: Greek letters and mathematical signs. */
const symbolFont = new Map<number, string>([
  ...[...'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'].map((value, index) => [0x41 + index, value] as const),
  ...[...'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'].map((value, index) => [0x61 + index, value] as const),
  ...Object.entries({
    0x22: '∀',
    0x24: '∃',
    0x27: '∋',
    0x2a: '∗',
    0x2d: '−',
    0x40: '≅',
    0x5c: '∴',
    0x5e: '⊥',
    0x7e: '∼',
    0xa0: '€',
    0xa1: 'ϒ',
    0xa2: '′',
    0xa3: '≤',
    0xa4: '⁄',
    0xa5: '∞',
    0xa6: 'ƒ',
    0xa7: '♣',
    0xa8: '♦',
    0xa9: '♥',
    0xaa: '♠',
    0xab: '↔',
    0xac: '←',
    0xad: '↑',
    0xae: '→',
    0xaf: '↓',
    0xb0: '°',
    0xb1: '±',
    0xb2: '″',
    0xb3: '≥',
    0xb4: '×',
    0xb5: '∝',
    0xb6: '∂',
    0xb7: '•',
    0xb8: '÷',
    0xb9: '≠',
    0xba: '≡',
    0xbb: '≈',
    0xbc: '…',
    0xc0: 'ℵ',
    0xc1: 'ℑ',
    0xc2: 'ℜ',
    0xc3: '℘',
    0xc4: '⊗',
    0xc5: '⊕',
    0xc6: '∅',
    0xc7: '∩',
    0xc8: '∪',
    0xc9: '⊃',
    0xca: '⊇',
    0xcb: '⊄',
    0xcc: '⊂',
    0xcd: '⊆',
    0xce: '∈',
    0xcf: '∉',
    0xd0: '∠',
    0xd1: '∇',
    0xd2: '®',
    0xd3: '©',
    0xd4: '™',
    0xd5: '∏',
    0xd6: '√',
    0xd7: '⋅',
    0xd8: '¬',
    0xd9: '∧',
    0xda: '∨',
    0xdb: '⇔',
    0xdc: '⇐',
    0xdd: '⇑',
    0xde: '⇒',
    0xdf: '⇓',
    0xe0: '◊',
    0xe1: '〈',
    0xe2: '®',
    0xe3: '©',
    0xe4: '™',
    0xe5: '∑',
    0xf1: '〉',
    0xf2: '∫',
  }).map(([code, value]) => [Number(code), value] as const),
  // Digits and punctuation that the Symbol font draws as themselves.
  ...[...' !#%&()+,./0123456789:;<=>?[]_{|}'].map(value => [value.charCodeAt(0), value] as const),
]);
/** Common Wingdings bullets and check marks. */
const wingdingsFont = new Map<number, string>([
  [0x6c, '●'],
  [0x6e, '■'],
  [0x6f, '□'],
  [0x71, '❑'],
  [0x76, '❖'],
  [0xa7, '▪'],
  [0xd8, '➢'],
  [0xfb, '✗'],
  [0xfc, '✓'],
  [0xfd, '☒'],
  [0xfe, '☑'],
]);

/**
 * The text a symbol, non-breaking hyphen or optional hyphen shows: `''` for an optional hyphen, `undefined` for any
 * other element. A symbol font character outside the known tables rejects rather than becoming a wrong letter.
 */
function specialCharacter(node: XmlElement): string | undefined {
  if (is(node, word, 'noBreakHyphen')) return '-';
  if (is(node, word, 'softHyphen')) return '';
  if (!is(node, word, 'sym')) return undefined;
  const code = Number.parseInt(attribute(node, word, 'char') ?? '', 16);
  const font = (attribute(node, word, 'font') ?? '').trim().toLowerCase();
  const table = font === 'symbol' ? symbolFont : font === 'wingdings' ? wingdingsFont : undefined;
  const character =
    table && (code <= 0xff || (code >= 0xf000 && code <= 0xf0ff))
      ? table.get(code & 0xff)
      : code >= 0x20 && !(code >= 0x7f && code < 0xa0) && !(code >= 0xd800 && code <= 0xf8ff)
        ? String.fromCodePoint(code)
        : undefined;
  if (character === undefined) throw new KnowledgeParseError('unsupported');
  return character;
}

const isDeletedRow = (row: XmlElement) =>
  row.children.some(child => is(child, word, 'trPr') && child.children.some(value => is(value, word, 'del')));

type WordContext = {
  reader: DrawingReader;
  collector: MediaCollector;
  /** Comment ids and the tokens of their quoted blocks; `anchored` collects the ones placed in the text. */
  comments: Map<string, string>;
  anchored: Set<string>;
  hidden: { found: boolean };
};

/**
 * Rewrites one Word part for AnyDoc: media become token runs, comment references become comment tokens, hidden runs
 * and field instructions go, a legacy checkbox shows its state, and deleted table rows are removed. Deleted and
 * moved-out text is left for AnyDoc, which already drops it.
 */
function rewriteWordPart(
  path: string,
  bytes: Buffer,
  context: WordContext,
  dropPageNumbers = false,
): { text: string; edits: Edit[] } {
  const { text, root } = readXmlSource(bytes);
  const edits: Edit[] = [];
  const fields = new FieldState(dropPageNumbers);
  const prefixOf = (node: XmlElement) => (node.raw.includes(':') ? `${node.raw.split(':')[0]}:` : '');
  const media = (node: XmlElement) =>
    is(node, word, 'pict') ||
    is(node, word, 'object') ||
    is(node, compatibility, 'AlternateContent') ||
    (is(node, word, 'drawing') &&
      !first(node, value => is(value, drawing, 'graphicData') && attribute(value, '', 'uri') === textBoxUri));
  const readRun = (run: XmlElement): void => {
    const hidden = isHidden(run);
    let mark = shiftMark(run);
    const kept: XmlElement[] = [];
    const removed: XmlElement[] = [];
    const runEdits: Edit[] = [];
    for (const child of run.children) {
      if (is(child, word, 'rPr')) continue;
      if (is(child, word, 'fldChar')) {
        const glyph = fields.character(child);
        if (glyph && !hidden) {
          runEdits.push({
            start: child.start,
            end: child.end,
            value: `<${prefixOf(child)}t>${glyph}</${prefixOf(child)}t>`,
          });
          kept.push(child);
        } else removed.push(child);
        continue;
      }
      if (is(child, word, 'instrText') || is(child, word, 'delInstrText')) {
        fields.instruction(child);
        removed.push(child);
        continue;
      }
      const character = specialCharacter(child);
      if (fields.dropped || hidden) {
        if (hidden && !fields.dropped && (child.text.trim() || character || media(child))) context.hidden.found = true;
        removed.push(child);
        continue;
      }
      if (character !== undefined) {
        if (!character) {
          removed.push(child);
          continue;
        }
        runEdits.push({
          start: child.start,
          end: child.end,
          value: `<${prefixOf(child)}t xml:space="preserve">${escapeXml(mark + character)}</${prefixOf(child)}t>`,
        });
        kept.push(child);
        mark = '';
        continue;
      }
      kept.push(child);
      if (mark && is(child, word, 't') && child.text.trim()) {
        runEdits.push({
          start: child.start,
          end: child.start,
          value: `<${prefixOf(child)}t>${mark}</${prefixOf(child)}t>`,
        });
        mark = '';
      }
      if (is(child, word, 'commentReference')) {
        const id = attribute(child, word, 'id') ?? '';
        const token = context.comments.get(id);
        if (token && !context.anchored.has(id)) {
          context.anchored.add(id);
          runEdits.push({
            start: child.start,
            end: child.end,
            value: `<${prefixOf(child)}t>${token}</${prefixOf(child)}t>`,
          });
        }
        continue;
      }
      if (media(child)) {
        const properties = first(child, value => is(value, wordDrawing, 'docPr'));
        const alt = properties && (attribute(properties, '', 'descr') || attribute(properties, '', 'title'));
        const tokens = context.reader.read(path, child, alt);
        runEdits.push({ start: child.start, end: child.end, value: tokens.length ? tokenRun(run, text, tokens) : '' });
        continue;
      }
      // Text boxes inside the run are paragraphs of their own.
      for (const value of child.children) visit(value);
    }
    if (!kept.length && removed.length) {
      edits.push({ start: run.start, end: run.end, value: '' });
      return;
    }
    edits.push(...runEdits, ...removed.map(child => ({ start: child.start, end: child.end, value: '' })));
  };
  const visit = (node: XmlElement): void => {
    if (is(node, word, 'del') || is(node, word, 'moveFrom') || is(node, word, 'sdtPr')) return;
    if (
      (is(node, word, 'tr') && isDeletedRow(node)) ||
      (dropPageNumbers && is(node, word, 'fldSimple') && pageField.test(attribute(node, word, 'instr') ?? ''))
    ) {
      edits.push({ start: node.start, end: node.end, value: '' });
      return;
    }
    if (is(node, word, 'r')) {
      readRun(node);
      return;
    }
    if (is(node, word, 'altChunk')) {
      const prefix = prefixOf(node);
      const token = context.collector.gapToken('object', gapLabels.embeddedDocument);
      edits.push({
        start: node.start,
        end: node.end,
        value: `<${prefix}p><${prefix}r><${prefix}t>${token}</${prefix}t></${prefix}r></${prefix}p>`,
      });
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return { text, edits };
}

const inlineSkipped = ['del', 'moveFrom', 'sdtPr', 'instrText', 'delText', 'delInstrText', 'rPr', 'pPr'];

/** Plain text of a rewritten paragraph or cell. */
function inlineText(node: XmlElement): string {
  let result = '';
  const visit = (value: XmlElement): void => {
    if (value.name.startsWith(`${word}|`) && inlineSkipped.includes(localName(value))) return;
    if (is(value, word, 't')) result += value.text;
    else if (['tab', 'ptab', 'br', 'cr'].some(name => is(value, word, name))) result += ' ';
    for (const child of value.children) visit(child);
    if (is(value, word, 'p')) result += ' ';
  };
  visit(node);
  return result.replace(/\s+/g, ' ').trim();
}

function* unwrapContent(node: XmlElement): Generator<XmlElement> {
  for (const child of node.children) {
    if (is(child, word, 'sdt')) {
      const content = child.children.find(value => is(value, word, 'sdtContent'));
      if (content) yield* unwrapContent(content);
    } else if (is(child, word, 'customXml')) yield* unwrapContent(child);
    else yield child;
  }
}

/** Markdown paragraphs of a header, footer or comment; table rows become one line each. */
function blocksMarkdown(node: XmlElement): string[] {
  const blocks: string[] = [];
  for (const child of unwrapContent(node)) {
    if (is(child, word, 'p')) {
      const value = inlineText(child);
      if (value) blocks.push(escapeMarkdown(value));
    } else if (is(child, word, 'tbl')) {
      for (const row of unwrapContent(child)) {
        if (!is(row, word, 'tr')) continue;
        const cells = [...unwrapContent(row)].filter(cell => is(cell, word, 'tc')).map(inlineText);
        if (cells.some(Boolean)) blocks.push(cells.map(escapeMarkdown).join(' | '));
      }
    }
  }
  return blocks;
}

/**
 * Prepares a Word package for AnyDoc and returns Markdown to append after its body: comments that are not anchored
 * in the text, then the distinct headers and footers. Each comment is quoted after the paragraph that holds its
 * reference. Headers and footers come last, under their own headings, so they never interrupt the document's
 * outline; page number fields in them are left out, and one that is then empty is skipped.
 */
export function rewriteWord(pkg: OfficePackage, parts: Map<string, Buffer>, collector: MediaCollector): string {
  const main = pkg.main?.path;
  if (!main) return '';
  const rels = [...(pkg.relationships.get(main)?.values() ?? [])].filter(rel => !rel.external);
  const context: WordContext = {
    reader: new DrawingReader(pkg, parts, collector),
    collector,
    comments: new Map(),
    anchored: new Set(),
    hidden: { found: false },
  };
  const rewritten = (path: string, dropPageNumbers = false): XmlElement | undefined => {
    const bytes = parts.get(path);
    if (!bytes) return undefined;
    const { text, edits } = rewriteWordPart(path, bytes, context, dropPageNumbers);
    return readXmlSource(rewriteXml(text, edits)).root;
  };
  const tokens = collector.tokens.pattern;
  const comments = rels.find(rel => rel.type === `${office}/comments`);
  const commentsTree = comments && rewritten(comments.target);
  for (const comment of commentsTree?.children.filter(node => is(node, word, 'comment')) ?? []) {
    // Pictures in a comment are listed at the end of the document rather than inside the quote.
    const value = blocksMarkdown(comment).join(' ').replace(tokens, '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const author = escapeMarkdown(cleanAlt(attribute(comment, word, 'author')));
    context.comments.set(
      attribute(comment, word, 'id') ?? '',
      collector.block(`> Comment${author ? ` (${author})` : ''}: ${value}`),
    );
  }
  const notes = rels.filter(rel => /\/(?:footnotes|endnotes)$/.test(rel.type)).map(rel => rel.target);
  for (const path of [main, ...notes]) {
    const bytes = parts.get(path);
    if (!bytes) continue;
    const { text, edits } = rewriteWordPart(path, bytes, context);
    if (edits.length) parts.set(path, rewriteXml(text, edits));
  }
  const appendix = [...context.comments].filter(([id]) => !context.anchored.has(id)).map(([, token]) => token);
  const mainTree = pkg.trees.get(main);
  for (const kind of ['header', 'footer'] as const) {
    const byId = new Map(rels.filter(rel => rel.type === `${office}/${kind}`).map(rel => [rel.target, rel]));
    const referenced = mainTree
      ? [...walk(mainTree)]
          .filter(node => is(node, word, `${kind}Reference`))
          .map(node => pkg.relationships.get(main)?.get(attribute(node, office, 'id') ?? '')?.target)
      : [];
    const seen = new Set<string>();
    const sections: string[] = [];
    for (const path of new Set([...referenced, ...byId.keys()])) {
      if (!path || !byId.has(path)) continue;
      const tree = rewritten(path, true);
      const value = tree ? blocksMarkdown(tree).join('\n\n') : '';
      const meaningful =
        new RegExp(tokens.source).test(value) || /[\p{L}\p{N}]/u.test(value.replace(/\b(?:page|pg|of)\b/gi, ''));
      if (!meaningful || seen.has(value)) continue;
      seen.add(value);
      sections.push(value);
    }
    if (sections.length) appendix.push(`## ${kind === 'header' ? 'Header' : 'Footer'}`, ...sections);
  }
  if (context.hidden.found) collector.gap('other', 'unsupported-media', gapLabels.hiddenText);
  return appendix.join('\n\n');
}

/** Inserts `mark` at the start of a text element's content. */
function markText(source: string, node: XmlElement, mark: string): Edit | undefined {
  if (!mark || !node.text.trim()) return undefined;
  const open = source.indexOf('>', node.start) + 1;
  return { start: open, end: open, value: mark };
}

/**
 * Marks for DrawingML runs raised or lowered by `baseline`, set on the run or the paragraph's default run properties,
 * so `H₂O` cannot read as `H2O`.
 */
function baselineMarks(source: string, root: XmlElement): Edit[] {
  const edits: Edit[] = [];
  const baselineOf = (node: XmlElement | undefined, name: string) => {
    const properties = node?.children.find(child => is(child, drawing, name));
    return properties && attribute(properties, '', 'baseline');
  };
  for (const paragraph of walk(root)) {
    if (!is(paragraph, drawing, 'p')) continue;
    const inherited = baselineOf(
      paragraph.children.find(child => is(child, drawing, 'pPr')),
      'defRPr',
    );
    for (const run of paragraph.children) {
      if (!is(run, drawing, 'r') && !is(run, drawing, 'fld')) continue;
      const baseline = Number(baselineOf(run, 'rPr') ?? inherited ?? 0);
      const text = run.children.find(child => is(child, drawing, 't'));
      const edit = text && markText(source, text, baseline > 0 ? '^' : baseline < 0 ? '_' : '');
      if (edit) edits.push(edit);
    }
  }
  return edits;
}

function textShape(tokens: string[]): string {
  return `<p:sp xmlns:p="${presentation}" xmlns:a="${drawing}"><p:nvSpPr><p:cNvPr id="0" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(tokens.join(' '))}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

/**
 * Rewrites every slide so that a boundary token starts it and its media become text shapes holding tokens.
 * Returns the slide paths in presentation order with their boundary tokens.
 */
export function rewritePresentation(
  pkg: OfficePackage,
  parts: Map<string, Buffer>,
  collector: MediaCollector,
): { path: string; boundary: string }[] {
  const main = pkg.main;
  if (!main) return [];
  const rels = pkg.relationships.get(main.path);
  const tree = pkg.trees.get(main.path);
  const slides: { path: string; boundary: string }[] = [];
  const reader = new DrawingReader(pkg, parts, collector);
  for (const entry of tree ? walk(tree) : []) {
    if (!is(entry, presentation, 'sldId')) continue;
    const rel = rels?.get(attribute(entry, office, 'id') ?? '');
    const bytes = rel ? parts.get(rel.target) : undefined;
    if (!rel || !bytes) continue;
    const number = slides.length + 1;
    collector.at(`slide:${number}`, { kind: 'slide', slide: number });
    const boundary = collector.tokens.create();
    slides.push({ path: rel.target, boundary });
    const { text, root } = readXmlSource(bytes);
    const edits: Edit[] = [];
    const visit = (node: XmlElement): void => {
      for (const child of node.children) {
        if (is(child, presentation, 'grpSp')) visit(child);
        else if (isAutomaticField(child)) edits.push({ start: child.start, end: child.end, value: '' });
        else if (
          is(child, presentation, 'pic') ||
          is(child, presentation, 'contentPart') ||
          is(child, compatibility, 'AlternateContent') ||
          (is(child, presentation, 'graphicFrame') &&
            !first(
              child,
              value =>
                is(value, drawing, 'graphicData') &&
                [uris.chart, uris.table].includes(attribute(value, '', 'uri') ?? ''),
            ))
        ) {
          const tokens = is(child, presentation, 'contentPart')
            ? [collector.gapToken('other', gapLabels.drawing)]
            : reader.read(rel.target, child, undefined, false);
          edits.push({ start: child.start, end: child.end, value: tokens.length ? textShape(tokens) : '' });
        }
      }
    };
    const shapes = first(root, value => is(value, presentation, 'spTree'));
    if (!shapes) continue;
    visit(shapes);
    edits.push(...baselineMarks(text, root));
    const open = text.indexOf('>', shapes.start) + 1;
    edits.push(
      text[open - 2] === '/'
        ? { start: shapes.start, end: shapes.end, value: `<${shapes.raw}>${textShape([boundary])}</${shapes.raw}>` }
        : { start: open, end: open, value: textShape([boundary]) },
    );
    parts.set(rel.target, rewriteXml(text, edits));
    for (const notes of pkg.relationships.get(rel.target)?.values() ?? []) {
      const source = notes.type === `${office}/notesSlide` && !notes.external ? parts.get(notes.target) : undefined;
      if (!source) continue;
      const parsed = readXmlSource(source);
      const noteEdits = [
        ...[...walk(parsed.root)]
          .filter(isAutomaticField)
          .map(field => ({ start: field.start, end: field.end, value: '' })),
        ...baselineMarks(parsed.text, parsed.root),
      ];
      if (noteEdits.length) parts.set(notes.target, rewriteXml(parsed.text, noteEdits));
    }
  }
  return slides;
}

/** Slide-number and date placeholders hold generated fields, not author text; AnyDoc would print their stale value. */
function isAutomaticField(node: XmlElement): boolean {
  if (!is(node, presentation, 'sp')) return false;
  const placeholder = first(node, value => is(value, presentation, 'ph'));
  return !!placeholder && ['sldNum', 'dt'].includes(attribute(placeholder, '', 'type') ?? '');
}

/**
 * Media, charts and text in a worksheet's drawing, as blocks appended after the sheet's cells. AnyDoc 0.2.4 drops
 * spreadsheet drawings entirely.
 */
export function readSheetDrawing(
  pkg: OfficePackage,
  parts: Map<string, Buffer>,
  worksheet: string,
  collector: MediaCollector,
): string[] {
  const tree = pkg.trees.get(worksheet);
  const reader = new DrawingReader(pkg, parts, collector);
  const tokens: string[] = [];
  for (const node of tree?.children ?? []) {
    if (localName(node) !== 'drawing') continue;
    const rel = pkg.relationships.get(worksheet)?.get(attribute(node, office, 'id') ?? '');
    const drawingTree = rel && !rel.external ? pkg.trees.get(rel.target) : undefined;
    if (!rel || !drawingTree || !is(drawingTree, sheetDrawing, 'wsDr')) continue;
    for (const anchor of drawingTree.children) tokens.push(...reader.read(rel.target, anchor, undefined));
  }
  return tokens;
}

const sheetMl = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
/** Custom formats AnyDoc renders faithfully besides dates and times. */
const renderedFormats = new Set(['0%', 'yyyy-mm-dd', '#,##0;(#,##0)']);

/** True for a format that shows a date or time, which AnyDoc writes as an ISO date and time. */
function isDateFormat(code: string): boolean {
  const tokens = code
    .replace(/"[^"]*"/g, '')
    .replace(/[\\_*]./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
  return /[dmyhs]/i.test(tokens);
}

/**
 * Prepares a workbook for AnyDoc. Custom number formats other than dates, times and the few AnyDoc renders faithfully
 * become General, so a cell shows its saved value rather than a partial rendering of its format. Raised and lowered
 * rich-text runs keep a `^` or `_` mark.
 */
export function rewriteWorkbook(pkg: OfficePackage, parts: Map<string, Buffer>): void {
  const main = pkg.main?.path;
  if (!main) return;
  for (const rel of pkg.relationships.get(main)?.values() ?? []) {
    if (rel.external) continue;
    const kind = rel.type.slice(office.length + 1);
    const bytes = ['styles', 'sharedStrings', 'worksheet'].includes(kind) ? parts.get(rel.target) : undefined;
    if (!bytes) continue;
    const { text, root } = readXmlSource(bytes);
    const edits: Edit[] = [];
    for (const node of walk(root)) {
      if (kind === 'styles' && node.name === `${sheetMl}|numFmt`) {
        const code = attribute(node, '', 'formatCode') ?? '';
        if (renderedFormats.has(code) || isDateFormat(code)) continue;
        const id = escapeXml(attribute(node, '', 'numFmtId') ?? '');
        edits.push({ start: node.start, end: node.end, value: `<${node.raw} numFmtId="${id}" formatCode="General"/>` });
      }
      if (node.name !== `${sheetMl}|r`) continue;
      const align = node.children
        .find(child => child.name === `${sheetMl}|rPr`)
        ?.children.find(child => child.name === `${sheetMl}|vertAlign`);
      const value = align && attribute(align, '', 'val');
      const textNode = node.children.find(child => child.name === `${sheetMl}|t`);
      const edit =
        textNode && markText(text, textNode, value === 'superscript' ? '^' : value === 'subscript' ? '_' : '');
      if (edit) edits.push(edit);
    }
    if (edits.length) parts.set(rel.target, rewriteXml(text, edits));
  }
}
