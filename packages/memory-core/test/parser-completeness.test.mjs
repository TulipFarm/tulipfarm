import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKnowledgeDocument, KnowledgeParseError } from '../dist/parser.js';
import {
  altChunkDocx,
  annotationPdf,
  cellXlsx,
  mixedInlinePdf,
  paintedPdf,
  pdfLexicalControl,
  softMaskPdf,
  splitPaintPdf,
  symbolDocx,
  nativeHeading,
} from './fixtures/parser-completeness.mjs';
import { pdf, textStream } from './fixtures/knowledge-extraction-fixtures.mjs';
import { docx, pptx, officeParts, zip } from './fixtures/parser-documents.mjs';
import {
  numberedList,
  drawingTextBox,
  strictAdmissionFixtures,
  rewriteDocx,
} from './fixtures/knowledge-extraction-admission-fixtures.mjs';

const parse = (bytes, filename) => parseKnowledgeDocument({ bytes, filename, mediaType: 'application/octet-stream' });
const failure = code => error => error instanceof KnowledgeParseError && error.code === code;

const replacePart = (bytes, part, replace) =>
  zip(officeParts(bytes).map(([path, xml]) => [path, path === part ? replace(xml) : xml]));

test('DOCX closed grammar rejects unknown attributes, parts, properties and orphan notes', async () => {
  const fixtures = new Map(strictAdmissionFixtures());
  for (const name of [
    'unknown empty WordML element',
    'unknown WordML attribute',
    'unknown unqualified attribute',
    'unknown attribute in known namespace',
    'unreferenced unknown package part',
    'unknown package content type',
    'unknown document relationship type',
    'unknown root package relationship type',
    'empty hyperlink label',
    'orphan footnote body',
    'orphan endnote body',
    'numbering inside footnote',
    'numbering inside endnote',
  ])
    await assert.rejects(parse(await fixtures.get(name), 'facts.docx'), failure('unsupported'), name);
  assert.equal((await parse(await fixtures.get('struck out amount'), 'facts.docx')).markdown, 'Limit ~~450~~ 500\n');
});

test('DOCX special hyphens, revisions and unqualified semantic properties reject', async () => {
  for (const construct of [
    '<w:noBreakHyphen/>',
    '<w:softHyphen/>',
    '<w:sym w:font="Symbol" w:char="F02D"/>',
    '<w:rPr><w:vanish/></w:rPr>',
    '<w:rPr><w:webHidden/></w:rPr>',
    '<w:rPr><w:rtl/></w:rPr>',
    '<w:rPr><w:u/></w:rPr>',
    '<w:rPr><w:strike w:val="0"/></w:rPr>',
    '<w:rPr><w:b w:unknown="450"/></w:rPr>',
    '<w:rPr><w:rPrChange w:id="1"/></w:rPr>',
  ]) {
    const bytes = replacePart(docx(), 'word/document.xml', xml =>
      xml.replace('<w:t>Harvest apples on Tuesday.</w:t>', `${construct}<w:t>Balance 450</w:t>`),
    );
    await assert.rejects(parse(bytes, 'facts.docx'), failure('unsupported'), construct);
  }
  for (const revision of ['ins', 'del', 'moveFrom', 'moveTo']) {
    const bytes = replacePart(docx(), 'word/document.xml', xml =>
      xml.replace(
        '<w:r><w:t>Harvest apples on Tuesday.</w:t></w:r>',
        `<w:${revision} w:id="1" w:author="Reviewer"><w:r><w:t>450</w:t></w:r></w:${revision}>`,
      ),
    );
    await assert.rejects(parse(bytes, 'facts.docx'), failure('unsupported'), revision);
  }
  assert.equal(
    (await parse(symbolDocx(false), 'plain.docx')).markdown,
    'Orchard policy\n\nBalance -450\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
  );
});

test('DOCX qualified numbering and textbox grammar preserve literal facts', async () => {
  assert.equal((await parse(numberedList(), 'list.docx')).markdown, '450. Pay supplier\n451. Send receipt\n');
  assert.equal(
    (
      await parse(
        await rewriteDocx(numberedList(), [
          ['word/document.xml', xml => xml.replaceAll('<w:pPr>', '<w:pPr><w:pStyle w:val="Normal"/>')],
        ]),
        'styled-list.docx',
      )
    ).markdown,
    '450. Pay supplier\n451. Send receipt\n',
  );
  assert.equal((await parse(drawingTextBox(), 'textbox.docx')).markdown, 'Budget\n\nMaximum is 450\n');
});

test('XLSX inline and shared rich properties reject rather than flatten emphasis', async () => {
  for (const property of [
    '<strike/>',
    '<u val="single"/>',
    '<b/>',
    '<i/>',
    '<vertAlign val="subscript"/>',
    '<unknown val="450"/>',
  ]) {
    const content = `<r><rPr>${property}</rPr><t>450</t></r>`;
    for (const [cell, strings] of [
      [`<c r="B2" t="inlineStr"><is>${content}</is></c>`],
      ['<c r="B2" t="s"><v>0</v></c>', `<si>${content}</si>`],
    ])
      await assert.rejects(parse(cellXlsx(cell, strings), 'rich.xlsx'), failure('unsupported'), property);
  }
  for (const [cell, strings] of [
    ['<c r="B2" t="inlineStr"><is><r><t>Limit </t></r><r><rPr/><t>450</t></r></is></c>'],
    ['<c r="B2" t="s"><v>0</v></c>', '<si><r><t>Limit </t></r><r><t>450</t></r></si>'],
  ])
    assert.match((await parse(cellXlsx(cell, strings), 'plain.xlsx')).markdown, /\| Apple \| Limit 450 \|/);
});

test('XLSX rejects unqualified OOXML character escapes in values and worksheet context', async () => {
  for (const value of ['Balance _x002D_450', 'Literal _x005F_x002D_450', '_xD83D__xDE00_', '_x000A_450']) {
    for (const [cell, strings] of [
      [`<c r="B2" t="inlineStr"><is><t>${value}</t></is></c>`],
      ['<c r="B2" t="s"><v>0</v></c>', `<si><t>${value}</t></si>`],
      [`<c r="B2" t="str"><v>${value}</v></c>`],
    ])
      await assert.rejects(parse(cellXlsx(cell, strings), 'escape.xlsx'), failure('unsupported'));
    await assert.rejects(
      parse(
        replacePart(cellXlsx('<c r="B2"><v>450</v></c>'), 'xl/workbook.xml', xml => xml.replace('Inventory', value)),
        'escape.xlsx',
      ),
      failure('unsupported'),
    );
  }
  assert.equal(
    (await parse(cellXlsx('<c r="B2" t="inlineStr"><is><t>Balance -450</t></is></c>'), 'plain.xlsx')).markdown,
    '## Inventory\n\n| Fruit | Count |\n| --- | --- |\n| Apple | Balance -450 |\n',
  );
});

test('XLSX closes cell, row, worksheet and workbook semantic attributes and children', async () => {
  for (const cell of [
    '<c r="B2" t="inlineStr" unknown="450"><is><t>Budget</t></is></c>',
    '<c r="B2" t="inlineStr"><is><r><t unknown="450">Budget</t></r></is></c>',
    '<c r="B2" t="inlineStr"><is><r><unknown/><t>Budget</t></r></is></c>',
    '<c r="B2"><f t="shared" si="0">200+250</f><v>450</v></c>',
  ])
    await assert.rejects(parse(cellXlsx(cell), 'facts.xlsx'), failure('unsupported'));
  for (const [part, before, after] of [
    ['xl/worksheets/sheet1.xml', '<row r="2">', '<row r="2" hidden="1">'],
    ['xl/worksheets/sheet1.xml', '</sheetData>', '</sheetData><unknown>450</unknown>'],
    ['xl/workbook.xml', 'name="Inventory"', 'name="Inventory" state="hidden"'],
    [
      'xl/workbook.xml',
      '</sheets>',
      '</sheets><definedNames><definedName name="Limit">450</definedName></definedNames>',
    ],
  ])
    await assert.rejects(
      parse(
        replacePart(cellXlsx('<c r="B2"><v>450</v></c>'), part, xml => xml.replace(before, after)),
        'facts.xlsx',
      ),
      failure('unsupported'),
    );
  assert.match((await parse(cellXlsx('<c r="B2"><v>450</v></c>'), 'plain.xlsx')).markdown, /\| Apple \| 450 \|/);
});

function styledWorkbook(formatCode = undefined, property = '') {
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const parts = officeParts(cellXlsx('<c r="B2" s="0"><v>450</v></c>')).map(([path, xml]) => [
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
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${formatCode === undefined ? '' : `<numFmts count="1"><numFmt numFmtId="164" formatCode="${formatCode}"/></numFmts>`}<fonts count="1"><font><sz val="11"/><name val="Calibri"/>${property}</font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="${formatCode === undefined ? 0 : 164}" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
  ]);
  return zip(parts);
}

test('XLSX ordinary styles remain supported while unqualified numeric formats and font semantics reject', async () => {
  assert.match((await parse(styledWorkbook(), 'styles.xlsx')).markdown, /\| Apple \| 450 \|/);
  for (const property of ['<strike/>', '<b/>', '<i/>', '<u/>', '<vertAlign val="superscript"/>']) {
    await assert.rejects(parse(styledWorkbook(undefined, property), 'styles.xlsx'), failure('unsupported'), property);
  }
  for (const format of ['0&quot; kg&quot;', '[Red]0', '0.00E+00', ';;;']) {
    await assert.rejects(parse(styledWorkbook(format), 'format.xlsx'), failure('unsupported'), format);
  }
  await assert.rejects(
    parse(
      replacePart(styledWorkbook(), 'xl/styles.xml', xml => xml.replace('numFmtId="0"', 'numFmtId="999"')),
      'format.xlsx',
    ),
    failure('unsupported'),
  );
});

test('PPTX closes text content and rejects semantic run properties including defaults', async () => {
  const run = '<a:r><a:t>Orchard harvest briefing</a:t></a:r>';
  for (const property of [
    'baseline="-25000"',
    'baseline="25000"',
    'strike="sngStrike"',
    'strike="dblStrike"',
    'u="sng"',
    'b="1"',
    'unknown="450"',
  ]) {
    for (const content of [
      `<a:r><a:rPr ${property}/><a:t>450</a:t></a:r>`,
      `<a:pPr><a:defRPr ${property}/></a:pPr><a:r><a:t>450</a:t></a:r>`,
    ]) {
      await assert.rejects(
        parse(
          replacePart(pptx(), 'ppt/slides/slide1.xml', xml => xml.replace(run, content)),
          'facts.pptx',
        ),
        failure('unsupported'),
        property,
      );
    }
  }
  for (const content of [
    '<a:unknown><a:t>450</a:t></a:unknown>',
    '<a:r><a:rPr><a:t>450</a:t></a:rPr><a:t>Budget</a:t></a:r>',
    '<a:fld id="1" type="slidenum"><a:t>450</a:t></a:fld>',
  ]) {
    await assert.rejects(
      parse(
        replacePart(pptx(), 'ppt/slides/slide1.xml', xml => xml.replace(run, content)),
        'facts.pptx',
      ),
      failure('unsupported'),
    );
  }
  assert.equal((await parse(pptx(), 'plain.pptx')).markdown, '## Orchard harvest briefing\n');
});

test('mixed inline PDF with native heading and raster 450 requires OCR before publication', async () => {
  await assert.rejects(parse(mixedInlinePdf(), 'mixed.pdf'), failure('ocr-required'));
  assert.equal((await parse(pdf([textStream(nativeHeading)]), 'native.pdf')).markdown, `${nativeHeading}\n`);
});

for (const kind of ['inline', 'xobject', 'mask']) {
  for (const container of ['page', 'compressed', 'form']) {
    test(`${container} PDF ${kind} paint cannot produce partial native success`, async () => {
      await assert.rejects(parse(await paintedPdf(kind, container), 'mixed.pdf'), failure('ocr-required'));
    });
  }
}

test('PDF image operator lookalikes in comments, strings, names and dictionaries stay text', async () => {
  assert.equal((await parse(pdfLexicalControl(), 'native.pdf')).markdown, 'Budget BI ID EI Do 450 450\n');
  assert.equal((await parse(await paintedPdf('', 'form'), 'form.pdf')).markdown, `${nativeHeading}\n`);
});

test('PDF content arrays share paint operands and preserve ordinary native text', async () => {
  await assert.rejects(parse(await splitPaintPdf(true), 'painted.pdf'), failure('ocr-required'));
  assert.equal((await parse(await splitPaintPdf(false), 'unused.pdf')).markdown, `${nativeHeading}\n`);
});

test('PDF applied ExtGState soft-mask Form raster 450 requires OCR, not partial native success', async () => {
  await assert.rejects(parse(await softMaskPdf(), 'masked.pdf'), failure('ocr-required'));
});

test('PDF ordinary graphics state, SMask None and unused soft masks preserve native text', async () => {
  for (const bytes of [await softMaskPdf('absent'), await softMaskPdf('none'), await softMaskPdf('raster', false)]) {
    assert.equal((await parse(bytes, 'native.pdf')).markdown, 'Native heading and explanatory budget policy text\n');
  }
});

for (const appearance of ['N', 'R', 'D']) {
  for (const stateful of [false, true]) {
    for (const kind of ['inline', 'xobject', 'mask']) {
      test(`PDF annotation ${appearance} ${stateful ? 'state dictionary' : 'stream'} nested Form ${kind} requires OCR`, async () => {
        await assert.rejects(
          parse(await annotationPdf(kind, appearance, stateful), 'annotation.pdf'),
          failure('ocr-required'),
        );
      });
    }
  }
}

test('PDF annotation Form cycles fail closed and unqualified text appearances reject', async () => {
  await assert.rejects(parse(await annotationPdf('cycle'), 'cycle.pdf'), failure('malformed'));
  await assert.rejects(parse(await annotationPdf(''), 'native.pdf'), failure('unsupported'));
});

test('DOCX embedded HTML and Symbol-font minus are unsupported, ordinary minus survives', async () => {
  await assert.rejects(parse(altChunkDocx(), 'chunk.docx'), failure('unsupported'));
  await assert.rejects(parse(symbolDocx(), 'symbol.docx'), failure('unsupported'));
  const aliases = zip(
    officeParts(altChunkDocx()).map(([path, text]) => [
      path,
      text.replaceAll('w:', 'word:').replace('xmlns:w=', 'xmlns:word='),
    ]),
  );
  await assert.rejects(parse(aliases, 'chunk.docx'), failure('unsupported'));
  assert.equal(
    (await parse(symbolDocx(false), 'minus.docx')).markdown,
    'Orchard policy\n\nBalance -450\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
  );
});

for (const [name, cell, strings] of [
  ['missing table', '<c r="B2" t="s"><v>0</v></c>'],
  ['missing index', '<c r="B2" t="s"/>', '<si><t>450</t></si>'],
  ['out of range', '<c r="B2" t="s"><v>1</v></c>', '<si><t>450</t></si>'],
  ['negative index', '<c r="B2" t="s"><v>-1</v></c>', '<si><t>450</t></si>'],
  ['fractional index', '<c r="B2" t="s"><v>0.5</v></c>', '<si><t>450</t></si>'],
  ['invalid index', '<c r="B2" t="s"><v>apple</v></c>', '<si><t>450</t></si>'],
  ['empty shared string item', '<c r="B2" t="s"><v>0</v></c>', '<si>450</si>'],
  ['missing inline text element', '<c r="B2" t="inlineStr"><is>450</is></c>'],
  ['blank numeric value', '<c r="B2"><v/></c>'],
  ['invalid numeric value', '<c r="B2"><v>450 apples</v></c>'],
  ['invalid boolean value', '<c r="B2" t="b"><v>450</v></c>'],
  ['missing inline value', '<c r="B2" t="inlineStr"/>'],
  ['inline value with numeric type', '<c r="B2"><is><t>450</t></is></c>'],
  ['text outside value element', '<c r="B2">450</c>'],
]) {
  test(`XLSX ${name} is malformed rather than an omitted cell`, async () => {
    await assert.rejects(parse(cellXlsx(cell, strings), 'malformed.xlsx'), failure('malformed'));
  });
}

for (const cell of [
  '<c r="B2"><f>450+50</f></c>',
  '<c r="B2"><f>450+50</f><v/></c>',
  '<c r="B2" t="unknown"><v>450</v></c>',
  '<c r="B2" t="d"><v>2026-10-03</v></c>',
  '<c r="B2" t="e"><v>#DIV/0!</v></c>',
]) {
  test(`XLSX unsupported cell cannot silently disappear ${cell}`, async () => {
    await assert.rejects(parse(cellXlsx(cell), 'unsupported.xlsx'), failure('unsupported'));
  });
}

for (const [cell, strings, expected] of [
  ['<c r="B2" t="s"><v>0</v></c>', '<si><t>450</t></si>', '450'],
  ['<c r="B2" t="s"><v>0</v></c>', '<si><r><t>Maximum </t></r><r><t>450</t></r></si>', 'Maximum 450'],
  ['<c r="B2"><f>450+50</f><v>500</v></c>', undefined, '500'],
  ['<c r="B2" t="str"><f>"450"</f><v>450</v></c>', undefined, '450'],
  ['<c r="B2" t="inlineStr"><is><t>450</t></is></c>', undefined, '450'],
  ['<c r="B2" t="b"><v>0</v></c>', undefined, 'FALSE'],
  ['<c r="B2"><v>0</v></c>', undefined, '0'],
  ['<c r="B2"/>', undefined, ''],
]) {
  test(`XLSX supported cell retains its literal value ${cell}`, async () => {
    assert.equal(
      (await parse(cellXlsx(cell, strings), 'valid.xlsx')).markdown,
      `## Inventory\n\n| Fruit | Count |\n| --- | --- |\n| Apple | ${expected} |\n`,
    );
  });
}

test('RTF superscript, subscript and baseline shifts reject before flattening numeric meaning', async () => {
  for (const control of ['super', 'sub', 'up6', 'dn6']) {
    await assert.rejects(
      parse(Buffer.from(`{\\rtf1\\ansi Area 10{\\${control} 2} square metres}`), 'area.rtf'),
      failure('unsupported'),
    );
  }
  assert.equal(
    (await parse(Buffer.from('{\\rtf1\\ansi Area 10 squared metres}'), 'area.rtf')).markdown,
    'Area 10 squared metres\n',
  );
});

test('raw native conversion reproduces all five blockers while guarded parsing rejects them', async () => {
  const { toMarkdownBytes } = await import('@firecrawl/anydoc/index.js');
  for (const [bytes, filename, raw, code] of [
    [mixedInlinePdf(), 'mixed.pdf', `${nativeHeading}\n`, 'ocr-required'],
    [
      altChunkDocx(),
      'chunk.docx',
      'Orchard policy\n\nHarvest apples on Tuesday.\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
      'unsupported',
    ],
    [
      symbolDocx(),
      'symbol.docx',
      'Orchard policy\n\nBalance 450\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n',
      'unsupported',
    ],
    [
      cellXlsx('<c r="B2" t="s"><v>0</v></c>'),
      'shared.xlsx',
      '| Fruit | Count |\n| --- | --- |\n| Apple |  |\n',
      'malformed',
    ],
    [
      cellXlsx('<c r="B2"><f>450+50</f></c>'),
      'formula.xlsx',
      '| Fruit | Count |\n| --- | --- |\n| Apple |  |\n',
      'unsupported',
    ],
    [
      Buffer.from('{\\rtf1\\ansi Area 10{\\super 2} square metres}'),
      'area.rtf',
      'Area 102 square metres\n',
      'unsupported',
    ],
  ]) {
    assert.equal(await toMarkdownBytes(bytes), raw);
    await assert.rejects(parse(bytes, filename), failure(code));
  }
});

test('RTF escaped controls remain literal while unqualified controls reject', async () => {
  for (const [rtf, expected] of [
    ['{\\rtf1\\ansi Literal \\\\super 450}', 'Literal \\\\super 450\n'],
    ['{\\rtf1\\ansi Literal \\\\sub 450}', 'Literal \\\\sub 450\n'],
    ["{\\rtf1\\ansi Literal \\'5csuper 450}", 'Literal \\\\super 450\n'],
  ])
    assert.equal((await parse(Buffer.from(rtf), 'literal.rtf')).markdown, expected);
  for (const rtf of [
    '{\\rtf1\\ansi \\supermarket Budget 450}',
    '{\\rtf1\\ansi \\Super Budget 450}',
    '{\\rtf1\\ansi \\nosupersub Budget 450}',
    '{\\rtf1\\ansi \\up0 Budget 450}',
    '{\\rtf1\\ansi {\\*\\unknown\\bin6 \\super}Budget 450}',
  ])
    await assert.rejects(parse(Buffer.from(rtf), 'unknown.rtf'), failure('unsupported'));
});
