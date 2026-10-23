import { posix } from 'node:path';
import { KnowledgeParseError } from './contracts.js';
import { readXml, xmlName } from './xml.js';
import type { XmlElement } from './xml.js';
import { wordGrammar } from './word.js';
import { spreadsheetGrammar } from './spreadsheet.js';
import { presentationGrammar } from './presentation.js';

const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const slide = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentNs = 'http://schemas.openxmlformats.org/package/2006/content-types';
export type Relationship = { type: string; target: string; external: boolean };
export interface OfficePackage {
  /** Path and short root name of the main part, such as `w:document`. */
  main?: { path: string; root: string };
  trees: Map<string, XmlElement>;
  relationships: Map<string, Map<string, Relationship>>;
  worksheets: string[];
}
const microsoft = 'http://schemas.microsoft.com/office/2007/relationships';
/** Relationships to media, charts, diagrams and embedded objects. Their targets are read as opaque parts. */
const mediaKinds = new Set([
  'image',
  'chart',
  'diagramData',
  'diagramLayout',
  'diagramQuickStyle',
  'diagramColors',
  'oleObject',
  'package',
  'video',
  'audio',
  'aFChunk',
  `${microsoft}/media`,
  `${microsoft}/diagramDrawing`,
  `${microsoft}/hdphoto`,
]);

const packageMetadata = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata';
/**
 * Formatting, template, property and metadata parts. They are allowed, never grammar-checked and never converted
 * into text: AnyDoc reads the main part and its slides, sheets and notes.
 */
const ignoredTypes = new Set([
  ...[
    'styles',
    'theme',
    'themeOverride',
    'settings',
    'webSettings',
    'fontTable',
    'font',
    'customXml',
    'customXmlProps',
    'glossaryDocument',
    'slideLayout',
    'slideMaster',
    'notesMaster',
    'handoutMaster',
    'presProps',
    'viewProps',
    'tableStyles',
    'tags',
    'calcChain',
    'printerSettings',
    'table',
    'extended-properties',
    'custom-properties',
    'attachedTemplate',
  ].map(kind => `${office}/${kind}`),
  `${packageMetadata}/core-properties`,
  `${packageMetadata}/thumbnail`,
  `${microsoft}/stylesWithEffects`,
  'http://schemas.microsoft.com/office/2011/relationships/people',
  'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
  'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible',
]);
/** Macros and ActiveX controls are rejected wherever they appear, including inside ignored and opaque parts. */
const executable =
  /vbaProject|vbaData|macroEnabled|activeX|\/control$|keyMapCustomizations|attachedToolbars|wordVbaData/i;
/** Formats Word can import as an alternative-format chunk; the chunk is never read, only recorded as a gap. */
const chunkTypes =
  /^(?:text\/html|application\/xhtml\+xml|text\/plain|application\/rtf|text\/rtf|message\/rfc822|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml)$/;
/** Content types that may be declared for parts the package does not contain, as generators routinely do. */
const declarable =
  /^(?:(?:image|video|audio)\/[\w.+-]+|application\/vnd\.openxmlformats-officedocument\.[\w.+-]+|application\/vnd\.openxmlformats-package\.[\w.+-]+|application\/(?:x-fontdata|x-font-ttf|vnd\.ms-excel|msword|vnd\.ms-powerpoint|vnd\.ms-(?:office|word|excel|powerpoint)\.[\w.+-]+))$/;

export type OfficeGrammar = Readonly<
  Record<
    string,
    {
      children: string;
      repeated?: string;
      required?: string;
      attributes?: Readonly<Record<string, RegExp>>;
      requiredAttributes?: string;
      text?: boolean;
      /** Media, charts and objects are not grammar-checked; extraction turns them into media items or gaps. */
      opaque?: boolean | ((node: XmlElement) => boolean);
      /**
       * Formatting-only children (or `*` for any) that are allowed and skipped. Their subtree must hold no text, so a
       * fact cannot hide in them.
       */
      ignored?: string;
      /** Formatting-only attributes that are allowed with any value. */
      ignoredAttributes?: RegExp;
      /** Unwrapped to its content, which follows the grammar of the element holding it. */
      transparent?: boolean;
      /** Holds one transparent content element that follows the grammar of the element holding this one. */
      wrapper?: boolean;
    }
  >
>;

const namespaces = new Map([
  [word, 'w'],
  [sheet, 's'],
  [slide, 'p'],
  [office, 'r'],
  [packageNs, 'rel'],
  [contentNs, 'ct'],
  ['http://www.w3.org/XML/1998/namespace', 'xml'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'a'],
  ['http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'wp'],
  ['http://schemas.microsoft.com/office/word/2010/wordprocessingShape', 'wps'],
  ['http://schemas.openxmlformats.org/markup-compatibility/2006', 'mc'],
]);
const requiredString = /^\S(?:[^\r\n]*\S)?$/;
const packageGrammar: OfficeGrammar = {
  'ct:Types': { children: 'ct:Default ct:Override', repeated: 'ct:Default ct:Override' },
  'ct:Default': {
    children: '',
    attributes: { Extension: requiredString, ContentType: requiredString },
    requiredAttributes: 'Extension ContentType',
  },
  'ct:Override': {
    children: '',
    attributes: { PartName: requiredString, ContentType: requiredString },
    requiredAttributes: 'PartName ContentType',
  },
  'rel:Relationships': { children: 'rel:Relationship', repeated: 'rel:Relationship' },
  'rel:Relationship': {
    children: '',
    attributes: {
      Id: requiredString,
      Type: requiredString,
      Target: requiredString,
      TargetMode: /^(?:Internal|External)$/,
    },
    requiredAttributes: 'Id Type Target',
  },
};

export function checkOffice(parts: Map<string, Buffer>): OfficePackage {
  const trees = new Map<string, XmlElement>();
  const relationships = new Map<string, Map<string, Relationship>>();
  for (const [path, bytes] of parts) {
    if (path.endsWith('.xml') || path.endsWith('.rels')) trees.set(path, readXml(bytes));
  }
  for (const [path, tree] of trees) {
    if (!path.endsWith('.rels')) continue;
    if (tree.name !== xmlName(packageNs, 'Relationships')) malformed();
    const base = path === '_rels/.rels' ? '' : path.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');
    if (base === path || (base && !parts.has(base))) malformed();
    const rels = new Map<string, Relationship>();
    relationships.set(base, rels);
    for (const node of tree.children) {
      if (node.name !== xmlName(packageNs, 'Relationship')) malformed();
      const id = attr(node, 'Id');
      const type = attr(node, 'Type').replace('http://purl.oclc.org/ooxml/officeDocument/relationships/', `${office}/`);
      const mode = node.attributes.get('|TargetMode') ?? 'Internal';
      if (rels.has(id) || !['Internal', 'External'].includes(mode)) malformed();
      const external = mode === 'External';
      const target = external ? attr(node, 'Target') : resolvePart(base, attr(node, 'Target'));
      if (!external && !parts.has(target)) malformed();
      rels.set(id, { type, target, external });
    }
  }
  for (const [path, tree] of trees) {
    if (path.endsWith('.rels')) continue;
    for (const { namespace, root, list, entry } of [
      { namespace: sheet, root: 'workbook', list: 'sheets', entry: 'sheet' },
      { namespace: slide, root: 'presentation', list: 'sldIdLst', entry: 'sldId' },
    ]) {
      if (tree.name === xmlName(namespace, root)) {
        const declarations = tree.children.filter(child => child.name === xmlName(namespace, list));
        if (
          declarations.length !== 1 ||
          !declarations[0]?.children.some(child => child.name === xmlName(namespace, entry))
        )
          malformed();
      }
    }
    const rels = relationships.get(path) ?? new Map<string, Relationship>();
    const related = (id: string, type?: string) => {
      const rel = rels.get(id);
      if (!rel || (type && (rel.external || rel.type !== `${office}/${type}`))) malformed();
      return rel;
    };
    for (const node of walk(tree)) {
      if (
        node.name.startsWith(`${sheet}|`) &&
        [node.text, ...node.attributes.values()].some(value => /_x[0-9a-f]{4}_/i.test(value))
      ) {
        throw new KnowledgeParseError('unsupported');
      }
      for (const [key, id] of node.attributes) {
        // Slide shapes carry `r:id=""` on click actions that link nowhere.
        if (key.startsWith(`${office}|`) && id) related(id);
      }
      if (node.name === xmlName(sheet, 'sheet') || node.name === xmlName(slide, 'sldId')) {
        const isSlide = node.name === xmlName(slide, 'sldId');
        const rel = related(attr(node, 'id', office), isSlide ? 'slide' : 'worksheet');
        const target = trees.get(rel.target);
        if (!target || target.name !== xmlName(isSlide ? slide : sheet, isSlide ? 'sld' : 'worksheet')) malformed();
        if (
          isSlide &&
          !target.children.some(
            child =>
              child.name === xmlName(slide, 'cSld') &&
              child.children.some(shape => shape.name === xmlName(slide, 'spTree')),
          )
        )
          malformed();
        if (!isSlide && !target.children.some(child => child.name === xmlName(sheet, 'sheetData'))) malformed();
        if (!isSlide) checkWorksheet(target, [...rels.values()], trees);
      }
      for (const kind of ['header', 'footer']) {
        if (node.name === xmlName(word, `${kind}Reference`)) {
          related(attr(node, 'id', office), kind);
        }
      }
      for (const kind of ['footnote', 'endnote', 'comment']) {
        if (
          ![`${kind}Reference`, ...(kind === 'comment' ? ['commentRangeStart', 'commentRangeEnd'] : [])].some(
            name => node.name === xmlName(word, name),
          )
        )
          continue;
        const candidates = [...rels.values()].filter(rel => rel.type === `${office}/${kind}s` && !rel.external);
        if (candidates.length !== 1) malformed();
        const target = trees.get(candidates[0]?.target ?? '');
        const id = attr(node, 'id', word);
        if (
          !target ||
          target.name !== xmlName(word, `${kind}s`) ||
          !target.children.some(
            note => note.name === xmlName(word, kind) && note.attributes.get(xmlName(word, 'id')) === id,
          )
        )
          malformed();
      }
    }
  }
  const main = checkQualifiedOffice(parts, trees, relationships);
  const worksheets = [...trees.values()]
    .filter(tree => tree.name === xmlName(sheet, 'workbook'))
    .flatMap(tree => tree.children.filter(node => node.name === xmlName(sheet, 'sheets')))
    .flatMap(node => node.children.map(entry => attr(entry, 'name')));
  return { ...(main ? { main } : {}), trees, relationships, worksheets };
}

function checkWorksheet(worksheet: XmlElement, relationships: Relationship[], trees: Map<string, XmlElement>): void {
  const sharedRelationships = relationships.filter(rel => rel.type === `${office}/sharedStrings`);
  if (sharedRelationships.length > 1) malformed();
  const sharedRelationship = sharedRelationships[0];
  const shared = sharedRelationship && !sharedRelationship.external ? trees.get(sharedRelationship.target) : undefined;
  if (sharedRelationship && (!shared || shared.name !== xmlName(sheet, 'sst'))) malformed();
  if (shared?.children.some(node => node.name !== xmlName(sheet, 'si'))) throw new KnowledgeParseError('unsupported');
  const strings = shared?.children.filter(node => node.name === xmlName(sheet, 'si'));
  for (const cell of walk(worksheet)) {
    if (cell.name !== xmlName(sheet, 'c')) continue;
    if (cell.text.trim()) malformed();
    const values = cell.children.filter(node => node.name === xmlName(sheet, 'v'));
    const formulas = cell.children.filter(node => node.name === xmlName(sheet, 'f'));
    const inline = cell.children.filter(node => node.name === xmlName(sheet, 'is'));
    if (values.length > 1 || formulas.length > 1 || inline.length > 1) malformed();
    if (cell.children.some(node => !['v', 'f', 'is'].some(name => node.name === xmlName(sheet, name))))
      throw new KnowledgeParseError('unsupported');
    const value = values[0];
    if (value?.children.length) malformed();
    const type = cell.attributes.get('|t') ?? 'n';
    if (type !== 'inlineStr' && inline.length) malformed();
    // A formula without a saved value has nothing to show; extraction records the sheet as a gap.
    if (formulas.length && (!value || !value.text.trim())) {
      if (!['n', 'str', 'b'].includes(type)) throw new KnowledgeParseError('unsupported');
      continue;
    }
    switch (type) {
      case 's': {
        if (!strings || !value || !/^\d+$/.test(value.text.trim())) malformed();
        const index = Number(value.text.trim());
        if (!Number.isSafeInteger(index) || index >= strings.length) malformed();
        const string = strings[index];
        if (!string) malformed();
        checkCellString(string);
        break;
      }
      case 'n':
        if (
          value &&
          (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.text.trim()) ||
            !Number.isFinite(Number(value.text)))
        )
          malformed();
        break;
      case 'b':
        if (!value || !['0', '1'].includes(value.text.trim())) malformed();
        break;
      case 'str':
        if (!value) malformed();
        break;
      case 'inlineStr':
        if (inline.length !== 1 || value || formulas.length) malformed();
        if (inline[0]) checkCellString(inline[0]);
        break;
      case 'd':
      case 'e':
      default:
        throw new KnowledgeParseError('unsupported');
    }
  }
}

function checkCellString(node: XmlElement): void {
  if (node.text.trim() || !node.children.length) malformed();
  const plain = node.children.filter(child => child.name === xmlName(sheet, 't'));
  if (plain.length) {
    if (plain.length !== 1 || node.children.length !== 1 || plain[0]?.children.length) malformed();
    return;
  }
  for (const run of node.children) {
    if (run.name !== xmlName(sheet, 'r')) throw new KnowledgeParseError('unsupported');
    const text = run.children.filter(child => child.name === xmlName(sheet, 't'));
    if (run.text.trim() || text.length !== 1 || text[0]?.children.length) malformed();
    if (run.children.some(child => child.name !== xmlName(sheet, 't') && child.name !== xmlName(sheet, 'rPr')))
      throw new KnowledgeParseError('unsupported');
  }
}

function shortName(name: string): string {
  const [namespace, local] = name.split('|');
  if (!namespace) return local ?? '';
  const prefix = namespaces.get(namespace);
  return prefix ? `${prefix}:${local}` : name;
}

function words(value = ''): string[] {
  return value ? value.split(' ') : [];
}

/** Office extension namespaces, such as `w14` or `x14ac`, which only carry editing and rendering metadata. */
const extension = /^http:\/\/schemas\.microsoft\.com\/office\/(?!word\/2010\/wordprocessingShape\|)/;
const revisionIds = /^w:rsid(?:R|RPr|RDefault|P|Del|Sect|Tr)$/;

function hasText(node: XmlElement): boolean {
  return Boolean(node.text.trim()) || node.children.some(hasText);
}

function ignorableAttribute(name: string, raw: string): boolean {
  return name === 'mc:Ignorable' || revisionIds.test(name) || extension.test(raw);
}

type GrammarRule = OfficeGrammar[string];

/** Property children that only their real owner may hold, never a wrapper standing in for it. */
const ownProperties = new Set(['w:pPr', 'w:rPr', 'w:tblPr', 'w:tblGrid', 'w:trPr', 'w:tcPr', 'w:sectPr']);

/**
 * `transparent` wrappers (inserted text, content controls, simple fields) are unwrapped to their content, so their
 * children follow the grammar of the element that holds them. A `wrapper` (a content control) passes that grammar on.
 */
function checkGrammar(node: XmlElement, grammar: OfficeGrammar, container?: GrammarRule): void {
  let rule = grammar[shortName(node.name)];
  if (rule && (rule.opaque === true || (typeof rule.opaque === 'function' && rule.opaque(node)))) return;
  if (rule?.transparent) {
    if (!container) reject();
    const children = words(container.children)
      .filter(name => !ownProperties.has(name))
      .join(' ');
    rule = {
      ...rule,
      children,
      repeated: children,
      ignored: `${container.ignored ?? ''} ${rule.ignored ?? ''}`.trim(),
    };
  }
  if (!rule || (!rule.text && node.text.trim())) reject();
  const attributes = new Map(
    [...node.attributes]
      .filter(([name]) => !ignorableAttribute(shortName(name), name))
      .map(([name, value]) => [shortName(name), value]),
  );
  for (const [name, value] of attributes)
    if (!rule.attributes?.[name]?.test(value) && !rule.ignoredAttributes?.test(name)) reject();
  if (words(rule.requiredAttributes).some(name => !attributes.has(name))) reject();
  const ignored = words(rule.ignored);
  const seen = new Set<string>();
  const provided = new Set<string>();
  const inner = rule.wrapper ? container : rule;
  for (const child of node.children) {
    const name = shortName(child.name);
    if (
      (ignored.includes('*') || ignored.includes(name) || (extension.test(child.name) && !grammar[name])) &&
      !words(rule.children).includes(name)
    ) {
      if (hasText(child)) reject();
      continue;
    }
    if (!words(rule.children).includes(name) || (seen.has(name) && !words(rule.repeated).includes(name))) reject();
    if ((['w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr'].includes(name) && seen.size) || seen.has('w:sectPr'))
      reject();
    seen.add(name);
    for (const value of unwrapped(child, grammar)) provided.add(value);
    checkGrammar(child, grammar, inner);
  }
  if (words(rule.required).some(name => !seen.has(name) && !provided.has(name))) malformed();
}

/** Names an element contributes to its parent once wrappers are unwrapped. */
function unwrapped(node: XmlElement, grammar: OfficeGrammar): string[] {
  const rule = grammar[shortName(node.name)];
  if (!rule?.transparent && !rule?.wrapper) return [shortName(node.name)];
  return node.children.flatMap(child => unwrapped(child, grammar));
}

function checkQualifiedOffice(
  parts: Map<string, Buffer>,
  trees: Map<string, XmlElement>,
  relationships: Map<string, Map<string, Relationship>>,
): { path: string; root: string } | undefined {
  const candidates = [...trees].filter(([, tree]) =>
    ['w:document', 's:workbook', 'p:presentation'].includes(shortName(tree.name)),
  );
  if (!candidates.length) {
    if (parts.has('[Content_Types].xml')) reject();
    return undefined;
  }
  if (candidates.length !== 1) reject();
  const main = candidates[0];
  if (!main) malformed();
  const [mainPath, mainTree] = main;
  const root = shortName(mainTree.name);
  const grammar =
    root === 'w:document' ? wordGrammar : root === 's:workbook' ? spreadsheetGrammar : presentationGrammar;
  const allowedKinds =
    root === 'w:document'
      ? ['footnotes', 'endnotes', 'numbering', 'header', 'footer', 'comments']
      : root === 's:workbook'
        ? ['worksheet', 'sharedStrings', 'styles']
        : ['slide'];
  const partRoots = new Map([
    ['footnotes', 'w:footnotes'],
    ['endnotes', 'w:endnotes'],
    ['numbering', 'w:numbering'],
    ['header', 'w:hdr'],
    ['footer', 'w:ftr'],
    ['comments', 'w:comments'],
    ['worksheet', 's:worksheet'],
    ['sharedStrings', 's:sst'],
    ['styles', 's:styleSheet'],
    ['slide', 'p:sld'],
  ]);
  const reached = new Set(['[Content_Types].xml', mainPath]);
  const referencedLinks = new Set<string>();
  for (const [path, tree] of trees) {
    for (const node of walk(tree)) {
      const name = shortName(node.name);
      if (!['w:hyperlink', 's:hyperlink', 'a:hlinkClick', 'a:hlinkHover'].includes(name)) continue;
      const id = node.attributes.get(xmlName(office, 'id'));
      // Spreadsheet links to a cell, slide actions without a target and Word links to a bookmark carry no relationship.
      if (!id && (name !== 'w:hyperlink' || node.attributes.has(xmlName(word, 'anchor')))) continue;
      const rel = relationships.get(path)?.get(id ?? '');
      if (rel && name.startsWith('a:') && rel.type === `${office}/slide` && !rel.external) continue;
      if (
        !rel ||
        rel.type !== `${office}/hyperlink` ||
        !rel.external ||
        !/^(?:https?:\/\/|mailto:)[^\s<>"'\\]+$/.test(rel.target)
      )
        reject();
      if (
        name === 'w:hyperlink' &&
        ![...walk(node)].some(child => shortName(child.name) === 'w:t' && child.text.trim())
      )
        reject();
      referencedLinks.add(`${path}\0${id}`);
    }
  }
  partRoots.set('notesSlide', 'p:notes');
  const roles = new Map<string, string>([[mainPath, 'main']]);
  const queue = [mainPath];
  const visit = (target: string, role: string) => {
    const current = roles.get(target);
    if (current === role || (current && role === 'ignored')) return;
    // A part first reached as formatting may later prove to be content or media; it is then checked as such.
    if (current && current !== 'ignored') reject();
    roles.set(target, role);
    reached.add(target);
    queue.push(target);
  };
  const packageRels = relationships.get('');
  if (packageRels) {
    reached.add('_rels/.rels');
    const documents = [...packageRels.values()].filter(rel => rel.type === `${office}/officeDocument`);
    if (documents.length !== 1 || documents[0]?.external || documents[0]?.target !== mainPath) reject();
    for (const rel of packageRels.values()) {
      if (rel.type === `${office}/officeDocument`) continue;
      if (!ignoredTypes.has(rel.type) || rel.external) reject();
      visit(rel.target, 'ignored');
    }
  }
  const mediaOwners =
    root === 'w:document'
      ? ['main', 'footnotes', 'endnotes', 'header', 'footer', 'comments']
      : root === 's:workbook'
        ? ['worksheet']
        : ['slide', 'notesSlide'];
  for (let owner = queue.shift(); owner !== undefined; owner = queue.shift()) {
    const role = roles.get(owner) ?? '';
    const rels = relationships.get(owner);
    if (!rels) continue;
    reached.add(`${posix.dirname(owner)}/_rels/${posix.basename(owner)}.rels`);
    const kinds = new Set<string>();
    for (const [id, rel] of rels) {
      const kind = rel.type.startsWith(`${office}/`) ? rel.type.slice(office.length + 1) : rel.type;
      if (executable.test(rel.type)) reject();
      if (kind === 'hyperlink' && referencedLinks.has(`${owner}\0${id}`)) continue;
      if (role === 'ignored') {
        // Templates, masters and layouts may link to their template file, a website or a picture; none is read.
        if (rel.external) {
          if (!['hyperlink', 'image', 'attachedTemplate'].includes(kind)) reject();
        } else visit(rel.target, 'ignored');
        continue;
      }
      if (role === 'opaque' || (mediaOwners.includes(role) && mediaKinds.has(kind))) {
        if (!rel.external) visit(rel.target, 'opaque');
        continue;
      }
      if (!(role === 'main' && allowedKinds.includes(kind)) && ignoredTypes.has(rel.type)) {
        if (rel.external) reject();
        visit(rel.target, 'ignored');
        continue;
      }
      if (rel.external) reject();
      if (role === 'slide' && kind === 'notesSlide') {
        if (kinds.has(kind)) reject();
        kinds.add(kind);
        if (shortName(trees.get(rel.target)?.name ?? '') !== 'p:notes') malformed();
        visit(rel.target, 'notesSlide');
        continue;
      }
      if (role === 'notesSlide' && kind === 'slide' && roles.get(rel.target) === 'slide') continue;
      // A click action that jumps to another slide; that slide is reached and checked from the presentation.
      if (role === 'slide' && kind === 'slide' && shortName(trees.get(rel.target)?.name ?? '') === 'p:sld') continue;
      if (role === 'worksheet' && kind === 'drawing') {
        visit(rel.target, 'opaque');
        continue;
      }
      if (role !== 'main' || !allowedKinds.includes(kind)) reject();
      if (kinds.has(kind) && !['worksheet', 'slide', 'header', 'footer'].includes(kind)) reject();
      kinds.add(kind);
      const target = trees.get(rel.target);
      if (!target || shortName(target.name) !== partRoots.get(kind)) malformed();
      visit(rel.target, kind);
      if (kind === 'worksheet' || kind === 'slide') {
        const entryName = kind === 'worksheet' ? 's:sheet' : 'p:sldId';
        if (
          ![...walk(mainTree)].some(
            node => shortName(node.name) === entryName && node.attributes.get(xmlName(office, 'id')) === id,
          )
        )
          reject();
      }
    }
  }
  for (const [path, bytes] of parts) {
    if (path.endsWith('/') && bytes.length === 0 && [...reached].some(part => part.startsWith(path))) continue;
    if (!reached.has(path)) reject();
    if (roles.get(path) === 'opaque' || roles.get(path) === 'ignored') continue;
    const tree = trees.get(path);
    if (!tree) reject();
    checkGrammar(tree, path.endsWith('.rels') || path === '[Content_Types].xml' ? packageGrammar : grammar);
  }
  const unread = new Set(
    [...roles].filter(([, role]) => role === 'opaque' || role === 'ignored').map(([path]) => path),
  );
  checkContentTypes(trees, unread, parts);
  if (root === 'w:document') checkWordReferences(mainPath, trees, relationships, unread);
  if (root === 's:workbook') checkStyles(mainPath, trees, relationships);
  return { path: mainPath, root };
}

/** `opaque` holds media and ignored formatting parts, which are declared but never grammar-checked. */
function checkContentTypes(trees: Map<string, XmlElement>, opaque: Set<string>, parts: Map<string, Buffer>): void {
  const types = trees.get('[Content_Types].xml');
  if (!types || shortName(types.name) !== 'ct:Types') malformed();
  const contentTypes = new Map([
    ['w:document', 'wordprocessingml.document.main+xml'],
    ['w:footnotes', 'wordprocessingml.footnotes+xml'],
    ['w:endnotes', 'wordprocessingml.endnotes+xml'],
    ['w:numbering', 'wordprocessingml.numbering+xml'],
    ['w:hdr', 'wordprocessingml.header+xml'],
    ['w:ftr', 'wordprocessingml.footer+xml'],
    ['w:comments', 'wordprocessingml.comments+xml'],
    ['s:workbook', 'spreadsheetml.sheet.main+xml'],
    ['s:worksheet', 'spreadsheetml.worksheet+xml'],
    ['s:sst', 'spreadsheetml.sharedStrings+xml'],
    ['s:styleSheet', 'spreadsheetml.styles+xml'],
    ['p:presentation', 'presentationml.presentation.main+xml'],
    ['p:sld', 'presentationml.slide+xml'],
    ['p:notes', 'presentationml.notesSlide+xml'],
  ]);
  const declarations = new Set<string>();
  for (const node of types.children) {
    if (shortName(node.name) === 'ct:Default') {
      const extension = attr(node, 'Extension');
      const type = attr(node, 'ContentType');
      if (declarations.has(extension)) malformed();
      declarations.add(extension);
      if (executable.test(type)) reject();
      // Other extensions are declared for media, fonts and metadata parts, or for parts the package lacks.
      const matching = [...parts.keys()].filter(path => path.toLowerCase().endsWith(`.${extension.toLowerCase()}`));
      const media =
        !['xml', 'rels'].includes(extension.toLowerCase()) &&
        (matching.length ? matching.every(path => opaque.has(path)) : declarable.test(type));
      if (
        !(
          media ||
          (extension === 'xml' && attr(node, 'ContentType') === 'application/xml') ||
          (extension === 'rels' &&
            attr(node, 'ContentType') === 'application/vnd.openxmlformats-package.relationships+xml')
        )
      )
        reject();
    } else {
      const path = attr(node, 'PartName');
      if (declarations.has(path)) malformed();
      declarations.add(path);
      if (executable.test(attr(node, 'ContentType'))) reject();
      if (path.startsWith('/') && (opaque.has(path.slice(1)) || !parts.has(path.slice(1)))) {
        const type = attr(node, 'ContentType');
        if (!declarable.test(type) && !(opaque.has(path.slice(1)) && chunkTypes.test(type))) reject();
        continue;
      }
      const tree = trees.get(path.slice(1));
      const root = tree ? shortName(tree.name) : '';
      if (
        !path.startsWith('/') ||
        !contentTypes.has(root) ||
        attr(node, 'ContentType') !== `application/vnd.openxmlformats-officedocument.${contentTypes.get(root)}`
      )
        reject();
    }
  }
}

function checkWordReferences(
  main: string,
  trees: Map<string, XmlElement>,
  relationships: Map<string, Map<string, Relationship>>,
  unread: Set<string>,
): void {
  const references = new Set<string>();
  const bodies = new Set<string>();
  const numbering = [...(relationships.get(main)?.values() ?? [])].find(rel => rel.type === `${office}/numbering`);
  const numberingTree = numbering ? trees.get(numbering.target) : undefined;
  const definitions = new Map<string, string>();
  const abstracts = new Set<string>();
  if (numberingTree)
    for (const node of numberingTree.children) {
      if (shortName(node.name) === 'w:abstractNum') {
        const id = attr(node, 'abstractNumId', word);
        if (abstracts.has(id)) malformed();
        abstracts.add(id);
      } else if (shortName(node.name) === 'w:num') {
        const id = attr(node, 'numId', word);
        const abstract = node.children.find(child => shortName(child.name) === 'w:abstractNumId');
        if (!abstract || definitions.has(id)) malformed();
        definitions.set(id, attr(abstract, 'val', word));
      }
    }
  if ([...definitions.values()].some(id => !abstracts.has(id))) malformed();
  for (const [path, tree] of trees) {
    if (unread.has(path)) continue;
    for (const node of walk(tree)) {
      const name = shortName(node.name);
      if (name === 'w:numPr') {
        // Header, footer, comment and note lists are read as plain text paragraphs.
        const id = node.children.find(child => shortName(child.name) === 'w:numId');
        if (!id || !definitions.has(attr(id, 'val', word))) malformed();
      }
      for (const kind of ['footnote', 'endnote']) {
        if (name === `w:${kind}Reference`) {
          if (path !== main) reject();
          references.add(`${kind}:${attr(node, 'id', word)}`);
        }
        if (name === `w:${kind}`) {
          if (
            /^(?:separator|continuationSeparator|continuationNotice)$/.test(
              node.attributes.get(xmlName(word, 'type')) ?? '',
            )
          )
            continue;
          const key = `${kind}:${attr(node, 'id', word)}`;
          if (bodies.has(key) || !node.children.length) reject();
          bodies.add(key);
        }
        if (name === `w:${kind}Ref` && shortName(tree.name) !== `w:${kind}s`) reject();
      }
    }
  }
  if (bodies.size !== references.size || [...bodies].some(key => !references.has(key))) reject();
}

function checkStyles(
  main: string,
  trees: Map<string, XmlElement>,
  relationships: Map<string, Map<string, Relationship>>,
): void {
  const rel = [...(relationships.get(main)?.values() ?? [])].find(value => value.type === `${office}/styles`);
  const styles = rel ? trees.get(rel.target) : undefined;
  const group = (name: string) => styles?.children.find(node => shortName(node.name) === `s:${name}`)?.children ?? [];
  const formats = new Set(group('numFmts').map(node => attr(node, 'numFmtId')));
  if (formats.size !== group('numFmts').length) malformed();
  for (const node of [...group('cellXfs'), ...group('cellStyleXfs')]) {
    const format = node.attributes.get('|numFmtId') ?? '0';
    if (Number(format) >= 164 && !formats.has(format)) malformed();
    for (const [attribute, name] of [
      ['fontId', 'fonts'],
      ['fillId', 'fills'],
      ['borderId', 'borders'],
      ['xfId', 'cellStyleXfs'],
    ]) {
      if (!attribute || !name) continue;
      const value = node.attributes.get(`|${attribute}`);
      if (value !== undefined && Number(value) >= group(name).length) malformed();
    }
  }
  const used = new Set(['0']);
  for (const tree of trees.values())
    if (shortName(tree.name) === 's:worksheet') {
      const coordinates = new Set<string>();
      for (const cell of walk(tree))
        if (shortName(cell.name) === 's:c') {
          const reference = attr(cell, 'r');
          if (coordinates.has(reference)) malformed();
          coordinates.add(reference);
          const index = cell.attributes.get('|s');
          if (index !== undefined && Number(index) >= group('cellXfs').length) malformed();
          used.add(index ?? '0');
        }
    }
  // Unused fonts (heading and title cell styles, theme defaults) never reach text, so only used fonts are checked.
  const fontGrammar: OfficeGrammar = {
    ...spreadsheetGrammar,
    's:font': spreadsheetGrammar['s:usedFont'] ?? { children: '' },
  };
  for (const index of used) {
    const fontId = group('cellXfs')[Number(index)]?.attributes.get('|fontId');
    const font = fontId === undefined ? undefined : group('fonts')[Number(fontId)];
    if (font) checkGrammar(font, fontGrammar);
  }
}

function reject(): never {
  throw new KnowledgeParseError('unsupported');
}

function* walk(node: XmlElement): Generator<XmlElement> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

function attr(node: XmlElement, name: string, namespace = ''): string {
  const value = node.attributes.get(xmlName(namespace, name));
  if (!value) malformed();
  return value;
}

function resolvePart(base: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split('#')[0] ?? '');
  } catch {
    malformed();
  }
  if (
    !decoded ||
    /[\\?:]/.test(decoded) ||
    [...decoded].some(character => character.charCodeAt(0) <= 32) ||
    decoded.startsWith('//')
  )
    malformed();
  const result = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(base), decoded));
  if (result === '..' || result.startsWith('../')) malformed();
  return result;
}

function malformed(): never {
  throw new KnowledgeParseError('malformed');
}
