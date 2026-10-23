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
  ])
    await assert.rejects(parse(await fixtures.get(name), 'facts.docx'), failure('unsupported'), name);
  // A numbered list inside a note reads as the note's plain paragraphs.
  for (const name of ['numbering inside footnote', 'numbering inside endnote'])
    assert.equal(
      (await parse(await fixtures.get(name), 'facts.docx')).markdown,
      'Budget[^1]\n\n[^1]: 450. Pay supplier\n',
      name,
    );
  assert.equal((await parse(await fixtures.get('struck out amount'), 'facts.docx')).markdown, 'Limit ~~450~~ 500\n');
});

const wordRun = construct =>
  replacePart(docx(), 'word/document.xml', xml =>
    xml.replace('<w:t>Harvest apples on Tuesday.</w:t>', `${construct}<w:t>Balance 450</w:t>`),
  );
const wordText = text => `Orchard policy\n\n${text}\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 12 |\n`;

test('DOCX special hyphens, symbols, right-to-left and double strike read as their text', async () => {
  for (const [construct, text] of [
    ['<w:noBreakHyphen/>', '-Balance 450'],
    ['<w:softHyphen/>', 'Balance 450'],
    ['<w:sym w:font="Symbol" w:char="F02D"/>', '−Balance 450'],
    ['<w:sym w:font="Symbol" w:char="2D"/>', '−Balance 450'],
    ['<w:sym w:font="Symbol" w:char="F061"/>', 'αBalance 450'],
    ['<w:sym w:font="Symbol" w:char="F0B3"/>', '≥Balance 450'],
    ['<w:sym w:font="Wingdings" w:char="F0FC"/>', '✓Balance 450'],
    ['<w:sym w:font="Arial" w:char="2212"/>', '−Balance 450'],
    ['<w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:sym w:font="Symbol" w:char="F0B0"/>', '^°Balance 450'],
    ['<w:rPr><w:rtl/></w:rPr>', 'Balance 450'],
    ['<w:rPr><w:rtl w:val="0"/><w:cs/></w:rPr>', 'Balance 450'],
    ['<w:rPr><w:dstrike/></w:rPr>', '~~Balance 450~~'],
  ])
    assert.equal((await parse(wordRun(construct), 'facts.docx')).markdown, wordText(text), construct);
  for (const container of ['bdo', 'dir'])
    assert.equal(
      (
        await parse(
          replacePart(docx(), 'word/document.xml', xml =>
            xml.replace(
              '<w:r><w:t>Harvest apples on Tuesday.</w:t></w:r>',
              `<w:${container} w:val="rtl"><w:r><w:t>Balance 450</w:t></w:r></w:${container}>`,
            ),
          ),
          'facts.docx',
        )
      ).markdown,
      wordText('Balance 450'),
      container,
    );
  // A hidden symbol is hidden text; unmapped symbol-font and private-use characters cannot become a wrong letter.
  const hidden = await parse(wordRun('<w:rPr><w:vanish/></w:rPr><w:sym w:font="Symbol" w:char="F02D"/>'), 'facts.docx');
  assert.deepEqual(
    hidden.gaps.map(gap => gap.label),
    ['Hidden text'],
  );
  for (const construct of [
    '<w:sym w:font="Wingdings" w:char="F021"/>',
    '<w:sym w:font="Webdings" w:char="F061"/>',
    '<w:sym w:font="Arial" w:char="E000"/>',
    '<w:sym w:font="Arial" w:char="0007"/>',
    '<w:sym w:font="Symbol"/>',
    '<w:sym w:font="Symbol" w:char="F02D"><w:t>450</w:t></w:sym>',
    '<w:sym w:font="Symbol" w:char="F02D" w:unknown="450"/>',
    '<w:noBreakHyphen w:unknown="450"/>',
    '<w:rPr><w:b w:unknown="450"/></w:rPr>',
  ])
    await assert.rejects(parse(wordRun(construct), 'facts.docx'), failure('unsupported'), construct);
});

test('DOCX unqualified semantic properties reject while revisions read as current text', async () => {
  // Tracked changes read as the current text: insertions and move targets stay, deletions and move sources go.
  for (const [revision, kept] of [
    ['ins', true],
    ['del', false],
    ['moveFrom', false],
    ['moveTo', true],
  ]) {
    const bytes = replacePart(docx(), 'word/document.xml', xml =>
      xml.replace(
        '<w:r><w:t>Harvest apples on Tuesday.</w:t></w:r>',
        `<w:${revision} w:id="1" w:author="Reviewer"><w:r><w:${kept ? 't' : 'delText'}>450</w:${kept ? 't' : 'delText'}></w:r></w:${revision}><w:r><w:t> kept</w:t></w:r>`,
      ),
    );
    assert.ok((await parse(bytes, 'facts.docx')).markdown.split('\n').includes(kept ? '450 kept' : 'kept'), revision);
  }
  for (const construct of ['<w:vanish/>', '<w:webHidden/>', '<w:u/>', '<w:rPrChange w:id="1"><w:rPr/></w:rPrChange>']) {
    const bytes = replacePart(docx(), 'word/document.xml', xml =>
      xml.replace('<w:t>Harvest apples on Tuesday.</w:t>', `<w:rPr>${construct}</w:rPr><w:t>Balance 450</w:t>`),
    );
    const markdown = (await parse(bytes, 'facts.docx')).markdown;
    assert.equal(markdown.includes('Balance 450'), construct !== '<w:vanish/>', construct);
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

test('XLSX inline and shared rich text reads as plain text with raised and lowered marks', async () => {
  for (const [property, text] of [
    ['<strike/>', 'H2O'],
    ['<u val="single"/>', 'H2O'],
    ['<b/>', 'H2O'],
    ['<i/>', 'H2O'],
    ['<rFont val="Arial"/><charset val="0"/><family val="2"/><sz val="11"/><color rgb="FFFF0000"/>', 'H2O'],
    ['<vertAlign val="subscript"/>', 'H_2O'],
    ['<vertAlign val="superscript"/>', 'H^2O'],
    ['<unknown val="450"/>'],
    ['<b unknown="450"/>'],
  ]) {
    const content = `<r><t>H</t></r><r><rPr>${property}</rPr><t>2</t></r><r><t>O</t></r>`;
    for (const [cell, strings] of [
      [`<c r="B2" t="inlineStr"><is>${content}</is></c>`],
      ['<c r="B2" t="s"><v>0</v></c>', `<si>${content}</si>`],
    ]) {
      const parsed = parse(cellXlsx(cell, strings), 'rich.xlsx');
      if (text) assert.ok((await parsed).markdown.includes(`| Apple | ${text} |`), property);
      else await assert.rejects(parsed, failure('unsupported'), property);
    }
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
    '<c r="B2"><f t="shared" si="0" unknown="450">200+250</f><v>450</v></c>',
    '<c r="B2"><f t="dataTable">200+250</f><v>450</v></c>',
  ])
    await assert.rejects(parse(cellXlsx(cell), 'facts.xlsx'), failure('unsupported'));
  // Shared formulas, the master and its followers, read their saved values.
  for (const cell of [
    '<c r="B2"><f t="shared" ref="B2:B3" si="0">200+250</f><v>450</v></c>',
    '<c r="B2"><f t="shared" si="0"/><v>450</v></c>',
  ])
    assert.match((await parse(cellXlsx(cell), 'shared.xlsx')).markdown, /\| Apple \| 450 \|/, cell);
  const names = definitions =>
    replacePart(cellXlsx('<c r="B2"><v>450</v></c>'), 'xl/workbook.xml', xml =>
      xml.replace('</sheets>', `</sheets><definedNames>${definitions}</definedNames>`),
    );
  // A workbook's own defined names are ignored; macro names stay unsupported.
  assert.equal(
    (
      await parse(
        names(
          '<definedName name="Limit">450</definedName><definedName name="Range" comment="Budget">Inventory!$B$2</definedName>',
        ),
        'names.xlsx',
      )
    ).markdown,
    '## Inventory\n\n| Fruit | Count |\n| --- | --- |\n| Apple | 450 |\n',
  );
  for (const definition of [
    '<definedName name="Limit" function="1">450</definedName>',
    '<definedName name="Limit" vbProcedure="1">450</definedName>',
    '<definedName name="Limit" unknown="450">450</definedName>',
  ])
    await assert.rejects(parse(names(definition), 'names.xlsx'), failure('unsupported'), definition);
  for (const [part, before, after] of [
    ['xl/worksheets/sheet1.xml', '</sheetData>', '</sheetData><unknown>450</unknown>'],
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

function styledWorkbook(formatCode = undefined, property = '', value = '450') {
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const parts = officeParts(cellXlsx(`<c r="B2" s="0"><v>${value}</v></c>`)).map(([path, xml]) => [
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

test('XLSX ordinary styles and fonts remain supported and custom number formats show the saved value', async () => {
  assert.match((await parse(styledWorkbook(), 'styles.xlsx')).markdown, /\| Apple \| 450 \|/);
  // Whole-cell fonts read as plain text, whatever their emphasis, strike, underline or raised position.
  for (const property of ['<b/>', '<i/>', '<strike/>', '<u/>', '<u val="double"/>', '<vertAlign val="superscript"/>'])
    assert.match((await parse(styledWorkbook(undefined, property), 'styles.xlsx')).markdown, /\| Apple \| 450 \|/);
  // A custom format other than a date, a time or `0%` shows the saved value rather than invented formatting.
  for (const [format, value, text] of [
    ['0&quot; kg&quot;', '450', '450'],
    ['[Red]0', '450', '450'],
    ['0.00E+00', '450', '450'],
    [';;;', '450', '450'],
    ['&quot;$&quot;#,##0.00', '1234.5', '1234.5'],
    ['#,##0', '1234.5', '1234.5'],
    ['0.0%', '0.4567', '0.4567'],
    ['#,##0 \\h', '450', '450'],
    ['0%', '0.45', '45%'],
    ['dd/mm/yyyy', '45292', '2024-01-01'],
    ['[$-409]d-mmm-yyyy;@', '45292', '2024-01-01'],
    ['yyyy-mm-dd hh:mm', '45292.5', '2024-01-01 12:00:00'],
  ])
    assert.ok(
      (await parse(styledWorkbook(format, '', value), 'format.xlsx')).markdown.includes(`| Apple | ${text} |`),
      format,
    );
  // Unknown built-in formats are not invented.
  for (const id of ['11', '44', '999'])
    await assert.rejects(
      parse(
        replacePart(styledWorkbook(), 'xl/styles.xml', xml =>
          xml.replace(
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
            `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"/>`,
          ),
        ),
        'format.xlsx',
      ),
      error => error instanceof KnowledgeParseError,
      id,
    );
});

test('PPTX reads run emphasis, raised and lowered text and fields while closing unknown content', async () => {
  const run = '<a:r><a:t>Orchard harvest briefing</a:t></a:r>';
  const slide = content => replacePart(pptx(), 'ppt/slides/slide1.xml', xml => xml.replace(run, content));
  for (const [property, own, inherited] of [
    ['baseline="-25000"', '_450', '_450'],
    ['baseline="25000"', '^450', '^450'],
    ['baseline="0"', '450', '450'],
    ['strike="sngStrike"', '~~450~~', '450'],
    ['strike="dblStrike"', '~~450~~', '450'],
    ['u="sng"', '450', '450'],
    ['u="dbl"', '450', '450'],
    ['b="1"', '**450**', '450'],
  ]) {
    assert.equal(
      (await parse(slide(`<a:r><a:t>Budget </a:t></a:r><a:r><a:rPr ${property}/><a:t>450</a:t></a:r>`), 'f.pptx'))
        .markdown,
      `## Budget ${own}\n`,
      property,
    );
    assert.equal(
      (await parse(slide(`<a:pPr><a:defRPr ${property}/></a:pPr><a:r><a:t>450</a:t></a:r>`), 'f.pptx')).markdown,
      `## ${inherited}\n`,
      property,
    );
  }
  // Fields such as the slide number and date read as their saved text.
  for (const [content, text] of [
    [
      '<a:r><a:t>Slide </a:t></a:r><a:fld id="{1}" type="slidenum"><a:rPr lang="en-US"/><a:t>4</a:t></a:fld>',
      'Slide 4',
    ],
    ['<a:fld id="1" type="datetime1"><a:t>1/2/2024</a:t></a:fld>', '1/2/2024'],
    ['<a:fld id="1"><a:rPr baseline="30000"/><a:t>2</a:t></a:fld>', '^2'],
  ])
    assert.equal((await parse(slide(content), 'f.pptx')).markdown, `## ${text}\n`, content);
  for (const content of [
    '<a:r><a:rPr unknown="450"/><a:t>450</a:t></a:r>',
    '<a:pPr><a:defRPr unknown="450"/></a:pPr><a:r><a:t>450</a:t></a:r>',
    '<a:r><a:rPr baseline="up"/><a:t>450</a:t></a:r>',
    '<a:unknown><a:t>450</a:t></a:unknown>',
    '<a:r><a:rPr><a:t>450</a:t></a:rPr><a:t>Budget</a:t></a:r>',
    '<a:fld type="slidenum"><a:t>450</a:t></a:fld>',
    '<a:fld id="1" unknown="450"><a:t>4</a:t></a:fld>',
    '<a:fld id="1"><a:unknown/><a:t>4</a:t></a:fld>',
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

// A page that paints an image becomes page media; without a recognizer its native text is kept and the page is a gap.
async function imagePage(bytes, filename) {
  const result = await parse(bytes, filename);
  assert.deepEqual(
    result.gaps.map(gap => [gap.kind, gap.reason, gap.location]),
    [['image', 'recognition-unavailable', { kind: 'page', page: 1 }]],
  );
  return result;
}

test('mixed inline PDF with native heading and raster 450 becomes page media before publication', async () => {
  assert.equal((await imagePage(mixedInlinePdf(), 'mixed.pdf')).markdown, `${nativeHeading}\n`);
  assert.equal((await parse(pdf([textStream(nativeHeading)]), 'native.pdf')).markdown, `${nativeHeading}\n`);
});

for (const kind of ['inline', 'xobject', 'mask']) {
  for (const container of ['page', 'compressed', 'form']) {
    test(`${container} PDF ${kind} paint becomes page media rather than partial native success`, async () => {
      await imagePage(await paintedPdf(kind, container), 'mixed.pdf');
    });
  }
}

test('PDF image operator lookalikes in comments, strings, names and dictionaries stay text', async () => {
  assert.equal((await parse(pdfLexicalControl(), 'native.pdf')).markdown, 'Budget BI ID EI Do 450 450\n');
  assert.equal((await parse(await paintedPdf('', 'form'), 'form.pdf')).markdown, `${nativeHeading}\n`);
});

test('PDF content arrays share paint operands and preserve ordinary native text', async () => {
  await imagePage(await splitPaintPdf(true), 'painted.pdf');
  assert.equal((await parse(await splitPaintPdf(false), 'unused.pdf')).markdown, `${nativeHeading}\n`);
});

test('PDF applied ExtGState soft-mask Form raster 450 becomes page media, not partial native success', async () => {
  await imagePage(await softMaskPdf(), 'masked.pdf');
});

test('PDF ordinary graphics state, SMask None and unused soft masks preserve native text', async () => {
  for (const bytes of [await softMaskPdf('absent'), await softMaskPdf('none'), await softMaskPdf('raster', false)]) {
    assert.equal((await parse(bytes, 'native.pdf')).markdown, 'Native heading and explanatory budget policy text\n');
  }
});

for (const appearance of ['N', 'R', 'D']) {
  for (const stateful of [false, true]) {
    for (const kind of ['inline', 'xobject', 'mask']) {
      test(`PDF annotation ${appearance} ${stateful ? 'state dictionary' : 'stream'} nested Form ${kind} is unsupported`, async () => {
        // Annotations stay unsupported; page renders leave them out.
        await assert.rejects(
          parse(await annotationPdf(kind, appearance, stateful), 'annotation.pdf'),
          failure('unsupported'),
        );
      });
    }
  }
}

test('PDF annotation Form cycles fail closed and unqualified text appearances reject', async () => {
  await assert.rejects(parse(await annotationPdf('cycle'), 'cycle.pdf'), failure('malformed'));
  await assert.rejects(parse(await annotationPdf(''), 'native.pdf'), failure('unsupported'));
});

test('DOCX embedded HTML becomes a gap, Symbol-font minus reads as minus, ordinary minus survives', async () => {
  const chunkText = wordText('Harvest apples on Tuesday.');
  const chunkGaps = [['object', 'unsupported-media', 'Embedded document']];
  const chunk = await parse(altChunkDocx(), 'chunk.docx');
  assert.equal(chunk.markdown, chunkText);
  assert.deepEqual(
    chunk.gaps.map(gap => [gap.kind, gap.reason, gap.label]),
    chunkGaps,
  );
  assert.equal((await parse(symbolDocx(), 'symbol.docx')).markdown, wordText('Balance −450'));
  const aliases = zip(
    officeParts(altChunkDocx()).map(([path, text]) => [
      path,
      text.replaceAll('w:', 'word:').replace('xmlns:w=', 'xmlns:word='),
    ]),
  );
  const aliased = await parse(aliases, 'chunk.docx');
  assert.equal(aliased.markdown, chunkText);
  assert.deepEqual(
    aliased.gaps.map(gap => [gap.kind, gap.reason, gap.label]),
    chunkGaps,
  );
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
  '<c r="B2" t="str"><f>A1</f></c>',
]) {
  test(`XLSX formula without a saved value is a sheet gap ${cell}`, async () => {
    const result = await parse(cellXlsx(cell), 'uncached.xlsx');
    assert.equal(result.markdown, '## Inventory\n\n| Fruit | Count |\n| --- | --- |\n| Apple |  |\n');
    assert.deepEqual(
      result.gaps.map(gap => [gap.kind, gap.reason, gap.label, gap.location]),
      [['other', 'unsupported-media', 'Formula without a saved value', { kind: 'sheet', sheet: 1, name: 'Inventory' }]],
    );
  });
}

test('XLSX records one uncached-formula gap per sheet', async () => {
  const result = await parse(
    replacePart(cellXlsx('<c r="B2"><f>450+50</f></c>'), 'xl/worksheets/sheet1.xml', xml =>
      xml.replace('</sheetData>', '<row r="3"><c r="B3"><f>B2*2</f></c></row></sheetData>'),
    ),
    'uncached.xlsx',
  );
  assert.deepEqual(
    result.gaps.map(gap => gap.label),
    ['Formula without a saved value'],
  );
});

for (const cell of [
  '<c r="B2" t="e"><f>1/0</f></c>',
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

test('raw native conversion reproduces all five blockers while guarded parsing handles them', async () => {
  const { toMarkdownBytes } = await import('@firecrawl/anydoc/index.js');
  assert.equal(await toMarkdownBytes(mixedInlinePdf()), `${nativeHeading}\n`);
  await imagePage(mixedInlinePdf(), 'mixed.pdf');
  for (const [bytes, filename, raw, code] of [
    [
      cellXlsx('<c r="B2" t="s"><v>0</v></c>'),
      'shared.xlsx',
      '| Fruit | Count |\n| --- | --- |\n| Apple |  |\n',
      'malformed',
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
  // Raw conversion drops embedded HTML, the Symbol-font minus and an uncached formula without a trace.
  for (const [bytes, filename, raw, markdown, labels] of [
    [
      altChunkDocx(),
      'chunk.docx',
      wordText('Harvest apples on Tuesday.'),
      wordText('Harvest apples on Tuesday.'),
      ['Embedded document'],
    ],
    [symbolDocx(), 'symbol.docx', wordText('Balance 450'), wordText('Balance −450'), []],
    [
      cellXlsx('<c r="B2"><f>450+50</f></c>'),
      'formula.xlsx',
      '| Fruit | Count |\n| --- | --- |\n| Apple |  |\n',
      '## Inventory\n\n| Fruit | Count |\n| --- | --- |\n| Apple |  |\n',
      ['Formula without a saved value'],
    ],
  ]) {
    assert.equal(await toMarkdownBytes(bytes), raw);
    const result = await parse(bytes, filename);
    assert.equal(result.markdown, markdown, filename);
    assert.deepEqual(
      result.gaps.map(gap => gap.label),
      labels,
      filename,
    );
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
