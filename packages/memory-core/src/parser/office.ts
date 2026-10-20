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
type Relationship = { type: string; target: string; external: boolean };

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

export function checkOffice(parts: Map<string, Buffer>): string[] {
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
  let unsupported = false;
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
        if (key.startsWith(`${office}|`)) related(id);
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
          unsupported = true;
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
        if (kind === 'comment') unsupported = true;
      }
      if (
        [
          xmlName(word, 'hdr'),
          xmlName(word, 'ftr'),
          xmlName(word, 'comments'),
          xmlName(word, 'checkBox'),
          xmlName('http://schemas.microsoft.com/office/word/2010/wordml', 'checkbox'),
        ].includes(node.name)
      )
        unsupported = true;
    }
    if (
      [...rels.values()].some(rel =>
        ['header', 'footer', 'comments', 'aFChunk'].some(kind => rel.type === `${office}/${kind}`),
      )
    )
      unsupported = true;
  }
  if (unsupported) throw new KnowledgeParseError('unsupported');
  checkQualifiedOffice(parts, trees, relationships);
  return [...trees.values()]
    .filter(tree => tree.name === xmlName(sheet, 'workbook'))
    .flatMap(tree => tree.children.filter(node => node.name === xmlName(sheet, 'sheets')))
    .flatMap(node => node.children.map(entry => attr(entry, 'name')));
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
    if (formulas.length && (!value || !value.text.trim())) throw new KnowledgeParseError('unsupported');
    const type = cell.attributes.get('|t') ?? 'n';
    if (type !== 'inlineStr' && inline.length) malformed();
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
    for (const property of run.children.filter(child => child.name === xmlName(sheet, 'rPr'))) {
      if (property.children.length || property.attributes.size || property.text.trim())
        throw new KnowledgeParseError('unsupported');
    }
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

function checkGrammar(node: XmlElement, grammar: OfficeGrammar): void {
  const rule = grammar[shortName(node.name)];
  if (!rule || (!rule.text && node.text.trim())) reject();
  const attributes = new Map([...node.attributes].map(([name, value]) => [shortName(name), value]));
  for (const [name, value] of attributes) if (!rule.attributes?.[name]?.test(value)) reject();
  if (words(rule.requiredAttributes).some(name => !attributes.has(name))) reject();
  const seen = new Set<string>();
  for (const child of node.children) {
    const name = shortName(child.name);
    if (!words(rule.children).includes(name) || (seen.has(name) && !words(rule.repeated).includes(name))) reject();
    if ((['w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr'].includes(name) && seen.size) || seen.has('w:sectPr'))
      reject();
    seen.add(name);
    checkGrammar(child, grammar);
  }
  if (words(rule.required).some(name => !seen.has(name))) malformed();
}

function checkQualifiedOffice(
  parts: Map<string, Buffer>,
  trees: Map<string, XmlElement>,
  relationships: Map<string, Map<string, Relationship>>,
): void {
  const candidates = [...trees].filter(([, tree]) =>
    ['w:document', 's:workbook', 'p:presentation'].includes(shortName(tree.name)),
  );
  if (!candidates.length) {
    if (parts.has('[Content_Types].xml')) reject();
    return;
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
      ? ['footnotes', 'endnotes', 'numbering']
      : root === 's:workbook'
        ? ['worksheet', 'sharedStrings', 'styles']
        : ['slide'];
  const partRoots = new Map([
    ['footnotes', 'w:footnotes'],
    ['endnotes', 'w:endnotes'],
    ['numbering', 'w:numbering'],
    ['worksheet', 's:worksheet'],
    ['sharedStrings', 's:sst'],
    ['styles', 's:styleSheet'],
    ['slide', 'p:sld'],
  ]);
  const reached = new Set(['[Content_Types].xml', mainPath]);
  const referencedLinks = new Set<string>();
  for (const [path, tree] of trees) {
    for (const node of walk(tree))
      if (shortName(node.name) === 'w:hyperlink') {
        const id = attr(node, 'id', office);
        const rel = relationships.get(path)?.get(id);
        if (
          !rel ||
          rel.type !== `${office}/hyperlink` ||
          !rel.external ||
          !/^(?:https?:\/\/|mailto:)[^\s<>"'\\]+$/.test(rel.target)
        )
          reject();
        if (![...walk(node)].some(child => shortName(child.name) === 'w:t' && child.text.trim())) reject();
        referencedLinks.add(`${path}\0${id}`);
      }
  }
  for (const [owner, rels] of relationships) {
    const relPath = owner ? `${posix.dirname(owner)}/_rels/${posix.basename(owner)}.rels` : '_rels/.rels';
    reached.add(relPath);
    const kinds = new Set<string>();
    for (const [id, rel] of rels) {
      if (!owner) {
        if (rels.size !== 1 || rel.type !== `${office}/officeDocument` || rel.external || rel.target !== mainPath)
          reject();
        continue;
      }
      const kind = rel.type.slice(office.length + 1);
      if (kind === 'hyperlink' && referencedLinks.has(`${owner}\0${id}`)) continue;
      if (owner !== mainPath || !allowedKinds.includes(kind) || rel.type !== `${office}/${kind}` || rel.external)
        reject();
      if (kinds.has(kind) && !['worksheet', 'slide'].includes(kind)) reject();
      kinds.add(kind);
      const target = trees.get(rel.target);
      if (!target || shortName(target.name) !== partRoots.get(kind)) malformed();
      reached.add(rel.target);
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
    const tree = trees.get(path);
    if (!tree) reject();
    checkGrammar(tree, path.endsWith('.rels') || path === '[Content_Types].xml' ? packageGrammar : grammar);
  }
  checkContentTypes(trees);
  if (root === 'w:document') checkWordReferences(mainPath, trees, relationships);
  if (root === 's:workbook') checkStyles(mainPath, trees, relationships);
}

function checkContentTypes(trees: Map<string, XmlElement>): void {
  const types = trees.get('[Content_Types].xml');
  if (!types || shortName(types.name) !== 'ct:Types') malformed();
  const contentTypes = new Map([
    ['w:document', 'wordprocessingml.document.main+xml'],
    ['w:footnotes', 'wordprocessingml.footnotes+xml'],
    ['w:endnotes', 'wordprocessingml.endnotes+xml'],
    ['w:numbering', 'wordprocessingml.numbering+xml'],
    ['s:workbook', 'spreadsheetml.sheet.main+xml'],
    ['s:worksheet', 'spreadsheetml.worksheet+xml'],
    ['s:sst', 'spreadsheetml.sharedStrings+xml'],
    ['s:styleSheet', 'spreadsheetml.styles+xml'],
    ['p:presentation', 'presentationml.presentation.main+xml'],
    ['p:sld', 'presentationml.slide+xml'],
  ]);
  const declarations = new Set<string>();
  for (const node of types.children) {
    if (shortName(node.name) === 'ct:Default') {
      const extension = attr(node, 'Extension');
      if (declarations.has(extension)) malformed();
      declarations.add(extension);
      if (
        !(
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
  for (const [path, tree] of trees)
    for (const node of walk(tree)) {
      const name = shortName(node.name);
      if (name === 'w:numPr') {
        if (path !== main) reject();
        const id = node.children.find(child => shortName(child.name) === 'w:numId');
        if (!id || !definitions.has(attr(id, 'val', word))) malformed();
      }
      for (const kind of ['footnote', 'endnote']) {
        if (name === `w:${kind}Reference`) {
          if (path !== main) reject();
          references.add(`${kind}:${attr(node, 'id', word)}`);
        }
        if (name === `w:${kind}`) {
          const key = `${kind}:${attr(node, 'id', word)}`;
          if (bodies.has(key) || !node.children.length) reject();
          bodies.add(key);
        }
        if (name === `w:${kind}Ref` && shortName(tree.name) !== `w:${kind}s`) reject();
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
        }
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
