import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { OfficeSpecError, officeImageIds, officeImageInfo, renderOfficeDocument } from '../src/office-documents.ts';

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

const png = (width, height) => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
};
const imageId = '5b0f6f8e-2f0a-4c3b-9d7e-1a2b3c4d5e6f';
const images = (width, height) =>
  new Map([[imageId, { ...officeImageInfo(png(width, height)), bytes: png(width, height) }]]);

test('image headers give the type and pixel size, and anything else is refused', () => {
  assert.deepEqual(officeImageInfo(png(640, 480)), { type: 'png', width: 640, height: 480 });
  const gif = Buffer.from('GIF89a\0\0\0\0', 'binary');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(officeImageInfo(gif), { type: 'gif', width: 320, height: 200 });
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x02, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x2c,
    0x02, 0x58, 0x03,
  ]);
  assert.deepEqual(officeImageInfo(jpeg), { type: 'jpg', width: 600, height: 300 });
  assert.equal(officeImageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(officeImageInfo(png(0, 10)), null);
  assert.equal(officeImageInfo(new Uint8Array([0xff, 0xd8, 0x00])), null);
});

test('image ids are listed once, in order, from document blocks and every slide column', () => {
  const other = '6c1f7f9e-3f1b-4d4c-8e8f-2b3c4d5e6f70';
  assert.deepEqual(
    officeImageIds(
      'pptx',
      JSON.stringify({
        slides: [
          {
            layout: 'two-column',
            left: [{ type: 'image', fileId: other }],
            right: [{ type: 'image', fileId: imageId }],
          },
          { layout: 'content', content: [{ type: 'image', fileId: other }] },
        ],
      }),
    ),
    [other, imageId],
  );
  assert.deepEqual(officeImageIds('docx', JSON.stringify({ blocks: [{ type: 'image', fileId: imageId }] })), [imageId]);
  assert.deepEqual(officeImageIds('docx', 'not json'), []);
  assert.deepEqual(officeImageIds('xlsx', JSON.stringify({ sheets: [{ name: 'A', rows: [] }] })), []);
});

test('a document image is embedded, fitted to the text width, and renders the same bytes again', async () => {
  const spec = JSON.stringify({
    blocks: [
      { type: 'paragraph', text: 'Before' },
      { type: 'image', fileId: imageId, alt: 'Revenue by quarter' },
      { type: 'image', fileId: imageId, width: 25 },
    ],
  });
  const first = await renderOfficeDocument('docx', spec, images(1204, 602));
  const zip = await JSZip.loadAsync(first);
  assert.equal(Object.keys(zip.files).filter(name => name.startsWith('word/media/')).length, 1);
  const xml = await entry(first, 'word/document.xml');
  // 602 × 301 px and 151 × 75 px, in EMUs (9525 per pixel at 96 dpi).
  assert.match(xml, /<wp:extent cx="5734050" cy="2867025"\/>/);
  assert.match(xml, /<wp:extent cx="1438275" cy="714375"\/>/);
  assert.match(xml, /descr="Revenue by quarter"/);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(await renderOfficeDocument('docx', spec, images(1204, 602)), first);
});

test('a slide image keeps its shape inside its block and is never enlarged', async () => {
  const spec = JSON.stringify({
    slides: [{ layout: 'content', title: 'Team', content: [{ type: 'image', fileId: imageId, alt: 'Team photo' }] }],
  });
  const first = await renderOfficeDocument('pptx', spec, images(200, 100));
  const zip = await JSZip.loadAsync(first);
  assert.equal(Object.keys(zip.files).filter(name => name.startsWith('ppt/media/')).length, 1);
  const slide = await entry(first, 'ppt/slides/slide1.xml');
  assert.match(slide, /descr="Team photo"/);
  // 200 × 100 px at 96 dpi is 1905000 × 952500 EMU.
  assert.match(slide, /<a:ext cx="1905000" cy="952500"\/>/);
  assert.deepEqual(await renderOfficeDocument('pptx', spec, images(200, 100)), first);
});

test('an image block without its file is a spec error', async () => {
  await assert.rejects(
    renderOfficeDocument('docx', JSON.stringify({ blocks: [{ type: 'image', fileId: imageId }] })),
    error => error instanceof OfficeSpecError && error.message.includes(imageId),
  );
  await assert.rejects(
    renderOfficeDocument('docx', JSON.stringify({ blocks: [{ type: 'image', fileId: 'not-a-uuid' }] }), new Map()),
    OfficeSpecError,
  );
});
