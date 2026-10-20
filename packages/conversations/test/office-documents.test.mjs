import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { OfficeSpecError, renderOfficeDocument } from '../src/office-documents.ts';

const entry = async (bytes, path) => (await JSZip.loadAsync(bytes)).file(path).async('string');

test('a document spec renders headings, lists, tables, and links in its theme', async () => {
  const bytes = await renderOfficeDocument(
    'docx',
    JSON.stringify({
      theme: 'classic',
      pageNumbers: true,
      footer: 'Acme',
      blocks: [
        { type: 'title', text: 'Quarterly review', subtitle: 'Q3 2026' },
        { type: 'heading', level: 2, text: 'Highlights' },
        {
          type: 'paragraph',
          text: [
            'Revenue grew ',
            { text: '12%', bold: true },
            '. See ',
            { text: 'the report', link: 'https://example.com' },
          ],
        },
        { type: 'list', ordered: true, items: ['First', { text: 'Second', items: ['Nested'] }] },
        {
          type: 'table',
          header: ['Region', 'Sales'],
          rows: [
            ['North', '120'],
            ['South', '90'],
          ],
        },
        { type: 'pageBreak' },
      ],
    }),
  );
  const xml = await entry(bytes, 'word/document.xml');
  for (const text of ['Quarterly review', 'Highlights', '12%', 'Nested', 'Region', 'South'])
    assert.match(xml, new RegExp(text));
  assert.match(xml, /<w:hyperlink/);
  assert.match(await entry(bytes, 'word/numbering.xml'), /w:val="decimal"/);
  assert.match(await entry(bytes, 'word/styles.xml'), /Georgia/);
});

test('a workbook spec keeps formulas, formats, and the styled header', async () => {
  const bytes = await renderOfficeDocument(
    'xlsx',
    JSON.stringify({
      theme: 'modern',
      accentColor: '#112233',
      sheets: [
        {
          name: 'Sales',
          filter: true,
          columns: [{ header: 'Item' }, { header: 'Price', format: '$#,##0.00' }, { header: 'Due' }],
          rows: [
            ['Pens', 2.5, { date: '2026-11-01' }],
            ['Paper', 7, null],
            ['Total', { formula: '=SUM(B2:B3)', bold: true }, null],
          ],
        },
      ],
    }),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('Sales');
  assert.equal(sheet.getCell('A1').value, 'Item');
  assert.equal(sheet.getCell('A1').fill.fgColor.argb, 'FF112233');
  assert.deepEqual(sheet.getCell('B4').value, { formula: 'SUM(B2:B3)' });
  assert.equal(sheet.getCell('B2').numFmt, '$#,##0.00');
  assert.equal(sheet.getCell('C2').numFmt, 'yyyy-mm-dd');
  assert.ok(sheet.autoFilter);
  assert.equal(sheet.views[0].state, 'frozen');
});

test('a presentation spec renders every layout with notes', async () => {
  const bytes = await renderOfficeDocument(
    'pptx',
    JSON.stringify({
      theme: 'bold',
      slides: [
        { layout: 'title', title: 'Launch plan', subtitle: 'October' },
        { layout: 'section', title: 'Goals' },
        {
          title: 'Agenda',
          content: [{ type: 'list', items: ['Why', { text: 'How', items: ['Steps'] }] }],
          notes: 'Keep it short',
        },
        {
          layout: 'two-column',
          title: 'Compare',
          left: [{ type: 'paragraph', text: 'Before' }],
          right: [{ type: 'table', header: ['A'], rows: [['1']] }],
        },
      ],
    }),
  );
  const zip = await JSZip.loadAsync(bytes);
  assert.equal(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 4);
  assert.match(await entry(bytes, 'ppt/slides/slide1.xml'), /Launch plan/);
  assert.match(await entry(bytes, 'ppt/slides/slide3.xml'), /Steps/);
  assert.match(await entry(bytes, 'ppt/slides/slide4.xml'), /<a:tbl>/);
  assert.match(await entry(bytes, 'ppt/notesSlides/notesSlide3.xml'), /Keep it short/);
});

test('an invalid spec names the problem', async () => {
  await assert.rejects(renderOfficeDocument('docx', '{'), OfficeSpecError);
  await assert.rejects(
    renderOfficeDocument('xlsx', JSON.stringify({ sheets: [{ name: 'a/b' }] })),
    /Sheet names cannot contain/,
  );
  await assert.rejects(renderOfficeDocument('pptx', JSON.stringify({ theme: 'neon', slides: [{}] })), /theme/);
});

test('the same spec renders the same bytes, so a replayed proposal matches', async () => {
  const spec = JSON.stringify({
    blocks: [{ type: 'paragraph', text: [{ text: 'Docs', link: 'https://example.com' }] }],
  });
  const first = await renderOfficeDocument('docx', spec);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(await renderOfficeDocument('docx', spec), first);
  assert.doesNotMatch(await entry(first, 'docProps/core.xml'), /dcterms:created/);
});

test('richer elements: a contents field, sheet merges, dropdowns, links, notes, and a slide chart', async () => {
  const doc = await renderOfficeDocument(
    'docx',
    JSON.stringify({ blocks: [{ type: 'toc' }, { type: 'heading', level: 1, text: 'Intro' }] }),
  );
  assert.match(await entry(doc, 'word/document.xml'), />TOC \\h \\o/);
  assert.match(await entry(doc, 'word/settings.xml'), /w:updateFields/);

  const book = await renderOfficeDocument(
    'xlsx',
    JSON.stringify({
      sheets: [
        {
          name: 'Tasks',
          columns: [{ header: 'Task' }, { header: 'Status' }],
          rows: [
            [{ value: 'Spec', link: 'https://example.com/spec', note: 'Owner: Sam' }, 'Open'],
            [{ value: 'Q4', bold: true }, null],
          ],
          merges: ['A3:B3'],
          dropdowns: [{ range: 'B2:B50', options: ['Open', 'Done'] }],
        },
      ],
    }),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(book);
  const sheet = workbook.getWorksheet('Tasks');
  assert.equal(sheet.getCell('A2').value.hyperlink, 'https://example.com/spec');
  assert.equal(sheet.getCell('A2').note, 'Owner: Sam');
  assert.equal(sheet.getCell('B3').master.address, 'A3');
  assert.deepEqual(sheet.getCell('B10').dataValidation.formulae, ['"Open,Done"']);
  assert.match(await entry(book, 'xl/workbook.xml'), /fullCalcOnLoad="1"/);

  const spec = JSON.stringify({
    slideNumbers: true,
    footer: 'Acme',
    slides: [
      {
        title: 'Sales',
        content: [
          { type: 'chart', kind: 'column', categories: ['Q1', 'Q2'], series: [{ name: '2026', values: [3, 5] }] },
        ],
      },
    ],
  });
  const deck = await renderOfficeDocument('pptx', spec);
  const zip = await JSZip.loadAsync(deck);
  assert.ok(Object.keys(zip.files).some(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)));
  assert.match(await entry(deck, 'ppt/slides/slide1.xml'), /type="sldNum"/);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(await renderOfficeDocument('pptx', spec), deck);
  await assert.rejects(
    renderOfficeDocument(
      'pptx',
      JSON.stringify({
        slides: [
          { content: [{ type: 'chart', kind: 'pie', categories: ['a', 'b'], series: [{ name: 'x', values: [1] }] }] },
        ],
      }),
    ),
    /one value per category/,
  );
});
