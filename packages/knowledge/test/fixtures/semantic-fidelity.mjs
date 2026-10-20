import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { docx, xlsx, pptx, odt, officeParts, zip, docxFeature } from './parser-documents.mjs';
import { annotationPdf, cellXlsx, nativeHeading, symbolDocx, mixedInlinePdf } from './parser-completeness.mjs';
import { pdf, textStream } from '../../../conversations/test/knowledge-extraction-fixtures.mjs';
import {
  formPdf,
  strictAdmissionFixtures,
  rewriteDocx,
  numberedList,
} from '../../../conversations/test/knowledge-extraction-admission-fixtures.mjs';

export const qualification = {
  premise: 'AnyDoc accepted supported constructs preserve semantic meaning.',
  scope:
    'Bounded construct census, not exhaustive format certification or visual fidelity. Preserved means only that every declared literal fact survives.',
  oracle:
    'Each allOf group contains literal alternative encodings of one required fact. Every group must match. noneOf forbids an altered fact. Invalid cases must reject.',
  fixtures:
    'Minimal in-memory packages derived from existing builders. Office content-type declarations are completed here. ODT uses a stored first mimetype member and a manifest. No desktop-application roundtrip or schema certification is claimed.',
  exclusions:
    'No OCR, arbitrary fonts, layout equivalence, formula recalculation, macro execution, network fetch, publication, or real user files. Hidden and tracked content require explicit semantic distinction, not silent flattening.',
  policySensitive:
    'Underline and bold/italic cases measure lost emphasis, not changed numeric value. The tracked-change case requires review history, not a silently accepted final-view projection. These classes are reported separately from unambiguous missing or altered facts.',
  softHyphen:
    'A discretionary hyphen in co-operate need not render when no line break occurs. Its omission is not the signed-amount defect.',
  nativeText:
    'The native column calls AnyDoc even for text. The guarded text path uses the production UTF-8 decoder instead.',
  legacySource:
    'bbd663841ed19c8465debf18c1baf06a3ff456da:packages/conversations/src/knowledge-extraction-docx.ts and knowledge-extraction-worker.ts, inspected 2026-10-03 with git show.',
  legacyPolicy:
    'PDF rejected all annotations, form fields, and image paints. DOCX admitted a closed part/relationship/element/attribute grammar with paragraphs, runs, tables, explicit hyperlinks, paired notes, and selected formatting. It rejected special hyphens, symbols, fields, revisions, strike, vertical alignment, numbering, headers, comments, drawings, unknown markup and parts. Other Office/RTF/CSV formats were outside that worker.',
};

const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const facts = (...values) => ({ allOf: values.map(value => (Array.isArray(value) ? value : [value])), noneOf: [] });
const strike = ['Limit ~~450~~ 500', 'Limit <s>450</s> 500', 'Limit <del>450</del> 500'];
const exponent = [
  'Area 10<sup>2</sup> square metres',
  'Area 10² square metres',
  'Area 10^2 square metres',
  'Area 10^{2} square metres',
];
const subscript = ['H<sub>2</sub>O', 'H₂O', 'H_{2}O'];

function completeOffice(bytes) {
  const parts = officeParts(bytes);
  const types = parts.find(([path]) => path === '[Content_Types].xml');
  const contentTypes = [
    [/^xl\/worksheets\/.*\.xml$/, 'spreadsheetml.worksheet+xml'],
    [/^xl\/(?:strings|sharedStrings)\.xml$/, 'spreadsheetml.sharedStrings+xml'],
    [/^xl\/styles\.xml$/, 'spreadsheetml.styles+xml'],
    [/^ppt\/slides\/.*\.xml$/, 'presentationml.slide+xml'],
    [/^word\/facts\/footnotes\.xml$/, 'wordprocessingml.footnotes+xml'],
    [/^word\/facts\/header\.xml$/, 'wordprocessingml.header+xml'],
  ];
  for (const [path] of parts) {
    const match = contentTypes.find(([pattern]) => pattern.test(path));
    if (match && !types[1].includes(`PartName="/${path}"`))
      types[1] = types[1].replace(
        '</Types>',
        `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${match[1]}"/></Types>`,
      );
  }
  return zip(parts);
}

function wordBody(body, extra = []) {
  const parts = officeParts(docx()).map(([path, xml]) => [
    path,
    path === 'word/document.xml'
      ? xml
          .replace('<w:document ', `<w:document xmlns:r="${office}" `)
          .replace(/<w:body>[^]*<\/w:body>/, `<w:body>${body}</w:body>`)
      : xml,
  ]);
  return completeOffice(zip([...parts, ...extra]));
}

const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = content => `<w:p>${content}</w:p>`;
const sheetCell = (cell, shared) => completeOffice(cellXlsx(cell, shared));
function richCell(property, shared = false, before = 'Limit ', marked = '450', after = ' 500') {
  const rich = `<r><t xml:space="preserve">${before}</t></r><r><rPr>${property}</rPr><t>${marked}</t></r><r><t xml:space="preserve">${after}</t></r>`;
  return shared
    ? sheetCell('<c r="B2" t="s"><v>0</v></c>', `<si>${rich}</si>`)
    : sheetCell(`<c r="B2" t="inlineStr"><is>${rich}</is></c>`);
}

function formattedCell(value, formatCode) {
  const parts = officeParts(cellXlsx(`<c r="B2" s="1"><v>${value}</v></c>`)).map(([path, xml]) => [
    path,
    path === 'xl/_rels/workbook.xml.rels'
      ? xml.replace(
          '</Relationships>',
          `<Relationship Id="styles" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
        )
      : xml,
  ]);
  parts.push([
    'xl/styles.xml',
    `<styleSheet xmlns="${sheetNs}"><numFmts count="1"><numFmt numFmtId="164" formatCode="${formatCode}"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  ]);
  return completeOffice(zip(parts));
}

function slideRuns(content) {
  return completeOffice(
    zip(
      officeParts(pptx()).map(([path, xml]) => [
        path,
        path === 'ppt/slides/slide1.xml' ? xml.replace('<a:r><a:t>Orchard harvest briefing</a:t></a:r>', content) : xml,
      ]),
    ),
  );
}

async function odtContent(content, properties = '') {
  const mimetype = 'application/vnd.oasis.opendocument.text';
  const xml = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2"><office:automatic-styles><style:style style:name="Marked" style:family="text"><style:text-properties ${properties}/></style:style></office:automatic-styles><office:body><office:text>${content}</office:text></office:body></office:document-content>`;
  return rewriteDocx(
    odt(),
    [
      ['content.xml', xml],
      [
        'META-INF/manifest.xml',
        `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
      ],
    ],
    'STORE',
  );
}

async function distinctAnnotation(subtype) {
  const document = await PDFDocument.load(await annotationPdf(''));
  const page = document.getPage(0);
  const annotation = document.context.lookup(page.node.lookup(PDFName.of('Annots')).get(0));
  annotation.set(PDFName.of('Subtype'), PDFName.of(subtype));
  annotation.set(PDFName.of('Contents'), PDFString.of('Maximum is 450'));
  annotation.set(PDFName.of('F'), document.context.obj(4));
  annotation.set(PDFName.of('DA'), PDFString.of('/F1 12 Tf 0 g'));
  annotation.set(
    PDFName.of('AP'),
    document.context.obj({
      N: document.context.register(
        document.context.flateStream('BT /F1 12 Tf 72 650 Td (Maximum is 450) Tj ET', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 612, 792],
          Resources: page.node.Resources(),
        }),
      ),
    }),
  );
  if (subtype === 'Text') annotation.set(PDFName.of('Open'), document.context.obj(true));
  return Buffer.from(await document.save());
}

async function pageForm() {
  const document = await PDFDocument.load(await distinctAnnotation('Stamp'));
  const page = document.getPage(0);
  const annotation = document.context.lookup(page.node.lookup(PDFName.of('Annots')).get(0));
  const appearance = annotation.lookup(PDFName.of('AP')).get(PDFName.of('N'));
  page.node.Resources().set(PDFName.of('XObject'), document.context.obj({ Fact: appearance }));
  page.node.set(
    PDFName.of('Contents'),
    document.context.register(document.context.flateStream(`${textStream(nativeHeading)}\n/Fact Do`)),
  );
  page.node.delete(PDFName.of('Annots'));
  return Buffer.from(await document.save());
}

export async function semanticFidelityFixtures() {
  const cases = [];
  const add = (id, format, construct, build, expected, legacy = 'outside legacy worker', validity = 'valid-minimal') =>
    cases.push({ id, format, construct, build, expected, legacy, validity });
  const legacy = new Map(
    await Promise.all(strictAdmissionFixtures().map(async ([name, bytes]) => [name, await bytes])),
  );
  add(
    'pdf-page-text',
    'pdf',
    'ordinary page text',
    () => pdf([textStream('Balance -450')]),
    facts('Balance -450'),
    'allowed',
  );
  add(
    'pdf-page-form',
    'pdf',
    'text in page Form XObject',
    pageForm,
    facts(nativeHeading, 'Maximum is 450'),
    'allowed if text extraction complete',
  );
  for (const subtype of ['Text', 'FreeText', 'Stamp'])
    add(
      `pdf-annotation-${subtype}`,
      'pdf',
      `distinct ${subtype} annotation text`,
      () => distinctAnnotation(subtype),
      facts(nativeHeading, 'Maximum is 450'),
      'rejected all annotations',
    );
  add(
    'pdf-widget',
    'pdf',
    'AcroForm text widget value distinct from page heading',
    formPdf,
    facts('Budget', '450'),
    'rejected forms and annotations',
  );
  add(
    'pdf-inline-image',
    'pdf',
    'visible inline bitmap containing 450 alongside native text',
    mixedInlinePdf,
    facts(nativeHeading, '450'),
    'rejected image paints',
  );

  add(
    'docx-plain',
    'docx',
    'plainOffice heading, paragraph and table facts',
    docx,
    facts('Orchard policy', 'Harvest apples on Tuesday.', 'Fruit', 'Count', 'Apple', '12'),
    'table/plain runs allowed; heading style outside old grammar',
  );
  add(
    'docx-noBreakHyphen',
    'docx',
    'visible nonbreaking hyphen in signed amount',
    () =>
      zip(
        officeParts(symbolDocx()).map(([path, xml]) => [
          path,
          xml.replace('<w:sym w:font="Symbol" w:char="F02D"/>', '<w:noBreakHyphen/>'),
        ]),
      ),
    facts(['Balance -450', 'Balance −450', 'Balance ‐450', 'Balance ‑450']),
    'rejected special run elements',
  );
  add(
    'docx-softHyphen',
    'docx',
    'discretionary word hyphen without forced line break',
    () => wordBody(paragraph('<w:r><w:t>co</w:t><w:softHyphen/><w:t>operate</w:t></w:r>')),
    facts(['cooperate', 'co\u00adoperate', 'co-operate']),
    'rejected special run elements',
  );
  add(
    'docx-symbol',
    'docx',
    'Symbol font minus character',
    symbolDocx,
    facts(['Balance -450', 'Balance −450']),
    'rejected sym',
  );
  add(
    'docx-field',
    'docx',
    'complex field instruction with distinct cached display result',
    () =>
      wordBody(
        paragraph(
          `${run('Due ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE \\@ "yyyy-MM-dd" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('2026-10-03')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
        ),
      ),
    { ...facts('Due 2026-10-03'), noneOf: ['DATE', 'yyyy-MM-dd'] },
    'rejected fields',
  );
  add(
    'docx-tracked-change',
    'docx',
    'tracked deletion and insertion distinguish old and new values',
    () =>
      wordBody(
        paragraph(
          `${run('Limit ')}<w:del w:id="1" w:author="Reviewer" w:date="2026-10-03T00:00:00Z"><w:r><w:delText>450</w:delText></w:r></w:del>${run(' ')}<w:ins w:id="2" w:author="Reviewer" w:date="2026-10-03T00:00:00Z">${run('500')}</w:ins>`,
        ),
      ),
    facts(['~~450~~', '<del>450</del>', '<s>450</s>'], ['<ins>500</ins>', 'inserted: 500', '++500++']),
    'rejected revision wrappers',
  );
  add(
    'docx-hyperlink',
    'docx',
    'hyperlink label and distinct target',
    () =>
      wordBody(paragraph('<w:hyperlink r:id="policy"><w:r><w:t>Policy</w:t></w:r></w:hyperlink>'), [
        [
          'word/_rels/document.xml.rels',
          `<Relationships xmlns="${packageNs}"><Relationship Id="policy" Type="${office}/hyperlink" Target="https://example.com/450" TargetMode="External"/></Relationships>`,
        ],
      ]),
    facts('Policy', 'https://example.com/450'),
    'allowed explicit external link',
  );
  add(
    'docx-strike',
    'docx',
    'direct strike old amount',
    () => legacy.get('struck out amount'),
    facts(strike),
    'rejected strike',
  );
  add(
    'docx-superscript',
    'docx',
    'direct superscript exponent',
    () => legacy.get('superscript exponent'),
    facts(exponent),
    'rejected vertical alignment',
  );
  add(
    'docx-numbering',
    'docx',
    'list starts at 450 rather than one',
    numberedList,
    facts('450.', '451.', 'Pay supplier', 'Send receipt'),
    'rejected numbering parts and numPr',
  );
  add(
    'docx-header',
    'docx',
    'distinct header fact',
    () => completeOffice(docxFeature('header')),
    facts('Harvest apples on Tuesday.', 'Maximum is 450'),
    'rejected header parts',
  );
  add(
    'docx-footnote',
    'docx',
    'referenced footnote fact',
    () => completeOffice(docxFeature('footnotes')),
    facts('Budget[^1]', '[^1]: Maximum is 450'),
    'allowed paired notes',
  );
  add(
    'docx-invalid-property-text',
    'docx',
    'text illegally nested in run properties',
    () => legacy.get('text in run properties'),
    { reject: true },
    'rejected grammar',
    'invalid WordML parent',
  );

  add(
    'xlsx-plain',
    'xlsx',
    'plainOffice inline strings and numeric cell',
    () => completeOffice(xlsx()),
    facts('Fruit', 'Count', 'Apple', '12'),
  );
  add(
    'xlsx-sheet-name',
    'xlsx',
    'worksheet name supplies context distinct from cell contents',
    () => completeOffice(xlsx()),
    facts('Inventory', 'Fruit', 'Count', 'Apple', '12'),
  );
  for (const shared of [false, true]) {
    add(
      `xlsx-escape-${shared ? 'shared' : 'inline'}`,
      'xlsx',
      'OOXML escaped minus in signed amount',
      () =>
        shared
          ? sheetCell('<c r="B2" t="s"><v>0</v></c>', '<si><t>Balance _x002D_450</t></si>')
          : sheetCell('<c r="B2" t="inlineStr"><is><t>Balance _x002D_450</t></is></c>'),
      facts('Balance -450'),
    );
  }
  for (const shared of [false, true])
    add(
      `xlsx-strike-${shared ? 'shared' : 'inline'}`,
      'xlsx',
      `${shared ? 'shared' : 'inline'} rich-text strikethrough`,
      () => richCell('<strike/>', shared),
      facts(strike),
    );
  add(
    'xlsx-underline',
    'xlsx',
    'underlined amount',
    () => richCell('<u val="single"/>'),
    facts(['Limit <u>450</u> 500', 'Limit <ins>450</ins> 500']),
  );
  add(
    'xlsx-superscript',
    'xlsx',
    'rich-text superscript exponent',
    () => richCell('<vertAlign val="superscript"/>', false, 'Area 10', '2', ' square metres'),
    facts(exponent),
  );
  add(
    'xlsx-rich-bold-italic',
    'xlsx',
    'bold italic amount carries emphasis',
    () => richCell('<b/><i/>'),
    facts(['***450***', '**_450_**', '_**450**_', '<strong><em>450</em></strong>']),
  );
  add(
    'xlsx-cached-formula',
    'xlsx',
    'formula with literal cached result',
    () => sheetCell('<c r="B2"><f>200+250</f><v>450</v></c>'),
    facts('450'),
  );
  add(
    'xlsx-uncached-formula',
    'xlsx',
    'formula without cached result',
    () => sheetCell('<c r="B2"><f>200+250</f></c>'),
    facts('450'),
  );
  add(
    'xlsx-percent',
    'xlsx',
    'numeric display format changes scale to percentage',
    () => formattedCell('0.45', '0%'),
    facts('45%'),
  );
  add(
    'xlsx-date',
    'xlsx',
    'serial displayed as ISO calendar date',
    () => formattedCell('45292', 'yyyy-mm-dd'),
    facts('2024-01-01'),
  );
  add(
    'xlsx-negative-format',
    'xlsx',
    'negative amount displayed in accounting parentheses',
    () => formattedCell('-450', '#,##0;(#,##0)'),
    facts(['(450)', '-450', '−450']),
  );
  add(
    'xlsx-invalid-shared-index',
    'xlsx',
    'shared-string index has no target',
    () => sheetCell('<c r="B2" t="s"><v>9</v></c>', '<si><t>Maximum is 450</t></si>'),
    { reject: true },
    'outside legacy worker',
    'invalid shared-string reference',
  );

  add(
    'rtf-plain',
    'rtf',
    'plain paragraph and signed number',
    () => Buffer.from('{\\rtf1\\ansi Balance -450}'),
    facts('Balance -450'),
  );
  add(
    'rtf-strike',
    'rtf',
    'struck-out old amount',
    () => Buffer.from('{\\rtf1\\ansi Limit {\\strike 450} 500}'),
    facts(strike),
  );
  add(
    'rtf-hidden',
    'rtf',
    'hidden text must not become unqualified visible amount',
    () => Buffer.from('{\\rtf1\\ansi Limit {\\v 450}500}'),
    { ...facts('Limit 500'), noneOf: ['450'] },
  );
  add(
    'rtf-unicode-destination',
    'rtf',
    'Unicode alternative destination replaces ANSI fallback',
    () => Buffer.from('{\\rtf1\\ansi\\uc1 {\\upr{Balance 450}{\\*\\ud Balance \\u8722?450}}}'),
    facts('Balance −450'),
  );
  add(
    'rtf-tab',
    'rtf',
    'tab separates name and amount',
    () => Buffer.from('{\\rtf1\\ansi Limit\\tab 450}'),
    facts(['Limit\t450', 'Limit 450', 'Limit | 450']),
  );
  add(
    'rtf-super',
    'rtf',
    'superscript exponent',
    () => Buffer.from('{\\rtf1\\ansi Area 10{\\super 2} square metres}'),
    facts(exponent),
  );

  add('pptx-plain', 'pptx', 'plainOffice slide title', () => completeOffice(pptx()), facts('Orchard harvest briefing'));
  add(
    'pptx-strike',
    'pptx',
    'struck-out old amount in slide run',
    () =>
      slideRuns(
        '<a:r><a:t>Limit </a:t></a:r><a:r><a:rPr strike="sngStrike"/><a:t>450</a:t></a:r><a:r><a:t> 500</a:t></a:r>',
      ),
    facts(strike),
  );
  add(
    'pptx-subscript',
    'pptx',
    'run baseline changes chemical formula',
    () => slideRuns('<a:r><a:t>H</a:t></a:r><a:r><a:rPr baseline="-25000"/><a:t>2</a:t></a:r><a:r><a:t>O</a:t></a:r>'),
    facts(subscript),
  );
  add(
    'pptx-field',
    'pptx',
    'slide field cached text distinct from ordinary heading',
    () =>
      slideRuns(
        '<a:r><a:t>Budget </a:t></a:r><a:fld id="{6E472BED-B4DB-4D8A-BFAE-1EAF14E17016}" type="slidenum"><a:rPr/><a:t>450</a:t></a:fld>',
      ),
    facts('Budget', '450'),
  );

  add(
    'odt-plain',
    'odt',
    'plainOffice heading and paragraph',
    () =>
      odtContent('<text:h text:outline-level="1">Orchard policy</text:h><text:p>Harvest apples on Tuesday.</text:p>'),
    facts('Orchard policy', 'Harvest apples on Tuesday.'),
  );
  add(
    'odt-strike',
    'odt',
    'automatic text style strikethrough',
    () =>
      odtContent(
        '<text:p>Limit <text:span text:style-name="Marked">450</text:span> 500</text:p>',
        'style:text-line-through-style="solid" style:text-line-through-type="single"',
      ),
    facts(strike),
  );
  add(
    'odt-super',
    'odt',
    'automatic text style superscript exponent',
    () =>
      odtContent(
        '<text:p>Area 10<text:span text:style-name="Marked">2</text:span> square metres</text:p>',
        'style:text-position="super 58%"',
      ),
    facts(exponent),
  );

  add(
    'csv-plain',
    'csv',
    'plain rows and signed numbers',
    () => Buffer.from('Item,Balance\nApple,-450\n'),
    facts('Item', 'Balance', 'Apple', '-450'),
  );
  add(
    'csv-quoted',
    'csv',
    'quoted delimiter, newline and leading zero identifier',
    () => Buffer.from('Item,Code,Note\n"Apple, pear",00450,"Due Friday\nMaximum 450"\n'),
    facts('Apple, pear', '00450', 'Due Friday', 'Maximum 450'),
  );
  add(
    'text-plain',
    'txt',
    'literal Unicode sign and Markdown strike',
    () => Buffer.from('# Balance\n\nBalance −450\nLimit ~~450~~ 500\n'),
    facts('# Balance', 'Balance −450', 'Limit ~~450~~ 500'),
  );
  add(
    'text-invalid-utf8',
    'txt',
    'invalid UTF-8 cannot publish replacement characters',
    () => Buffer.from([0x42, 0x61, 0x6c, 0xff, 0x34, 0x35, 0x30]),
    { reject: true },
    'text rejected invalid UTF-8',
    'invalid UTF-8',
  );
  const requiredControls = new Set([
    'pdf-page-text',
    'docx-plain',
    'xlsx-plain',
    'pptx-plain',
    'odt-plain',
    'rtf-plain',
    'csv-plain',
    'text-plain',
  ]);
  const policySensitive = new Set(['docx-tracked-change', 'xlsx-underline', 'xlsx-rich-bold-italic']);
  return cases.map(fixture => ({
    ...fixture,
    mustAccept: requiredControls.has(fixture.id),
    interpretation: policySensitive.has(fixture.id)
      ? 'explicit review-history or emphasis policy'
      : 'literal content or numeric meaning',
  }));
}
