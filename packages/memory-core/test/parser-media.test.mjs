import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadImage } from '@napi-rs/canvas';
import { KnowledgeParseError } from '../dist/parser.js';
import { extractKnowledgeDocument, readKnowledgeMedia } from '../dist/parser/process.js';
import { mediaPdf, mediaPptx, pictureDocx, pictureXlsx, png, storedPng } from './fixtures/parser-media.mjs';
import { zip } from './fixtures/parser-documents.mjs';

const input = (bytes, extension) => ({ bytes, filename: `media.${extension}`, mediaType: 'application/octet-stream' });
const placeholder = id => `\uE000media:${id}\uE001`;
const paragraphs = markdown => markdown.split(/\n{2,}/).map(part => part.trim());

function assertPlacedOnce(extraction) {
  for (const item of extraction.media) {
    const holders = extraction.segments.filter(segment => segment.markdown.includes(placeholder(item.id)));
    assert.equal(holders.length, 1, item.id);
    assert.deepEqual(holders[0].location, item.location);
    assert.ok(paragraphs(holders[0].markdown).includes(placeholder(item.id)), 'placeholder is its own paragraph');
  }
}

test('a DOCX picture becomes a placeholder paragraph and a part media item with its alt text', async () => {
  const bytes = await pictureDocx();
  const extraction = await extractKnowledgeDocument(input(bytes, 'docx'));
  assert.equal(extraction.segments.length, 1);
  assert.equal(extraction.segments[0].markdown, `Orchard plan\n\nSee below.\n\n${placeholder('m1')}\n`);
  assert.deepEqual(
    extraction.media.map(({ sha256: _sha256, ...item }) => item),
    [
      {
        id: 'm1',
        kind: 'image',
        ref: { kind: 'part', path: 'word/media/map.png' },
        location: { kind: 'passage' },
        alt: 'Orchard map',
        fallback: 'Orchard map',
      },
    ],
  );
  assert.equal(
    extraction.media[0].sha256,
    createHash('sha256')
      .update(await png())
      .digest('hex'),
  );
  assert.deepEqual(extraction.gaps, [
    { kind: 'image', reason: 'unsupported-media', location: { kind: 'passage' }, label: 'Linked image' },
  ]);
  assertPlacedOnce(extraction);
});

test('PPTX slides become ordered segments that keep their picture, chart table and notes', async () => {
  const extraction = await extractKnowledgeDocument(input(await mediaPptx(), 'pptx'));
  assert.deepEqual(
    extraction.segments.map(segment => segment.location),
    [
      { kind: 'slide', slide: 1 },
      { kind: 'slide', slide: 2 },
    ],
  );
  const [first, second] = extraction.segments.map(segment => segment.markdown);
  assert.match(first, /^## Harvest review\n/);
  assert.ok(first.includes(`\n\n${placeholder('m1')}\n\n`));
  assert.ok(first.includes('| North | 12 |\n| South | 30 |'));
  assert.ok(first.includes('> Mention the frost'));
  assert.equal(second, '## Field footage\n');
  assert.deepEqual(
    extraction.media.map(item => [item.id, item.ref, item.location, item.alt]),
    [['m1', { kind: 'part', path: 'ppt/media/photo.png' }, { kind: 'slide', slide: 1 }, 'Orchard photo']],
  );
  assert.deepEqual(extraction.gaps, [
    { kind: 'video', reason: 'unsupported-media', location: { kind: 'slide', slide: 2 }, label: 'Video' },
  ]);
  assertPlacedOnce(extraction);
});

test('XLSX drawing pictures, which AnyDoc drops, are added to their own sheet', async () => {
  const extraction = await extractKnowledgeDocument(input(await pictureXlsx(), 'xlsx'));
  assert.deepEqual(
    extraction.segments.map(segment => segment.location),
    [
      { kind: 'sheet', sheet: 1, name: 'Totals' },
      { kind: 'sheet', sheet: 2, name: 'Shelf_1' },
    ],
  );
  assert.ok(!extraction.segments[0].markdown.includes('\uE000'));
  assert.ok(extraction.segments[0].markdown.includes('Apples 12'));
  assert.match(extraction.segments[1].markdown, /^## Shelf\\_1\n/);
  assert.ok(extraction.segments[1].markdown.endsWith(`\n\n${placeholder('m1')}\n`));
  assert.deepEqual(
    extraction.media.map(item => [item.ref, item.alt]),
    [[{ kind: 'part', path: 'xl/media/shelf.png' }, 'Shelf photo']],
  );
  assertPlacedOnce(extraction);
});

test('PDF pages become page segments and image pages become page media with their text as fallback', async () => {
  const extraction = await extractKnowledgeDocument(input(await mediaPdf(['text', 'image', 'mixed']), 'pdf'));
  assert.equal(extraction.pages, 3);
  assert.deepEqual(
    extraction.segments.map(segment => [segment.location, segment.markdown]),
    [
      [{ kind: 'page', page: 1 }, '## Page 1 notes on the orchard.\n'],
      [{ kind: 'page', page: 2 }, `${placeholder('m1')}\n`],
      [{ kind: 'page', page: 3 }, `${placeholder('m2')}\n`],
    ],
  );
  assert.deepEqual(
    extraction.media.map(item => [item.kind, item.ref, item.fallback]),
    [
      ['page', { kind: 'pdf-page', page: 2 }, ''],
      ['page', { kind: 'pdf-page', page: 3 }, '## Page 3 notes on the orchard.'],
    ],
  );
  assertPlacedOnce(extraction);
});

test('a text-only PDF has no media', async () => {
  const extraction = await extractKnowledgeDocument(input(await mediaPdf(['text', 'text']), 'pdf'));
  assert.deepEqual(extraction.media, []);
  assert.deepEqual(extraction.gaps, []);
  assert.equal(extraction.segments.length, 2);
});

test('source text cannot forge placeholders', async () => {
  const forged = `Before ${placeholder('m1')} after \uE000\uE001\n`;
  const text = await extractKnowledgeDocument(input(Buffer.from(forged), 'md'));
  assert.deepEqual(text.segments, [{ location: { kind: 'passage' }, markdown: 'Before media:m1 after \n' }]);
  assert.deepEqual(text.media, []);
  const docx = await extractKnowledgeDocument(
    input(await pictureDocx({ text: `Forged ${placeholder('m1')}` }), 'docx'),
  );
  assert.ok(docx.segments[0].markdown.startsWith('Forged media:m1\n\n'));
  assertPlacedOnce(docx);
});

test('RTF pictures become rtf-picture media and are served as images', async () => {
  const hex = (await png()).toString('hex');
  const rtf = Buffer.from(`{\\rtf1\\ansi Before {\\pict\\pngblip\\picw64\\pich48 ${hex}} after}`, 'latin1');
  const extraction = await extractKnowledgeDocument(input(rtf, 'rtf'));
  assert.deepEqual(
    extraction.media.map(item => item.ref),
    [{ kind: 'rtf-picture', index: 0 }],
  );
  assertPlacedOnce(extraction);
  const { header, media } = await readKnowledgeMedia(input(rtf, 'rtf'), extraction.media);
  assert.equal(header.items[0].status, 'ready');
  assert.deepEqual([media[0].width, media[0].height], [64, 48]);
});

test('media mode returns decodable images with their dimensions', async () => {
  const docx = input(await pictureDocx(), 'docx');
  const { header, media } = await readKnowledgeMedia(docx, [
    { id: 'm1', kind: 'image', ref: { kind: 'part', path: 'word/media/map.png' } },
  ]);
  assert.deepEqual(header.items, [
    { id: 'm1', status: 'ready', mediaType: 'image/png', width: 64, height: 48, byteLength: media[0].bytes.length },
  ]);
  const image = await loadImage(Buffer.from(media[0].bytes));
  assert.deepEqual([image.width, image.height], [64, 48]);

  const pdf = input(await mediaPdf(['text', 'image']), 'pdf');
  const page = await readKnowledgeMedia(pdf, [{ id: 'm1', kind: 'page', ref: { kind: 'pdf-page', page: 2 } }]);
  assert.equal(page.header.items[0].mediaType, 'image/jpeg');
  assert.equal(Math.max(page.media[0].width, page.media[0].height), 1600);
  const rendered = await loadImage(Buffer.from(page.media[0].bytes));
  assert.deepEqual([rendered.width, rendered.height], [page.media[0].width, page.media[0].height]);
});

test('media mode reports tiny, missing and undecodable images instead of failing', async () => {
  const bytes = zip([
    ['word/media/tiny.png', await png(16, 16)],
    ['word/media/thin.png', await png(16, 200)],
    ['word/media/bad.png', Buffer.from('not an image')],
    ['word/media/scan.tiff', Buffer.from('II*\0')],
  ]);
  const part = path => ({ kind: 'part', path });
  const { header, media } = await readKnowledgeMedia(input(bytes, 'docx'), [
    { id: 'm1', kind: 'image', ref: part('word/media/tiny.png') },
    { id: 'm2', kind: 'image', ref: part('word/media/thin.png') },
    { id: 'm3', kind: 'image', ref: part('word/media/bad.png') },
    { id: 'm4', kind: 'image', ref: part('word/media/scan.tiff') },
    { id: 'm5', kind: 'image', ref: part('word/media/absent.png') },
  ]);
  assert.deepEqual(
    header.items.map(item => [item.id, item.status]),
    [
      ['m1', 'too-small'],
      ['m2', 'ready'],
      ['m3', 'unsupported'],
      ['m4', 'unsupported'],
      ['m5', 'unsupported'],
    ],
  );
  assert.equal(media.length, 1);
});

test('media mode rejects batches over the item limit', async () => {
  const items = Array.from({ length: 21 }, (_, index) => ({
    id: `m${index + 1}`,
    kind: 'image',
    ref: { kind: 'part', path: 'word/media/map.png' },
  }));
  await assert.rejects(
    readKnowledgeMedia(input(await pictureDocx(), 'docx'), items),
    error => error instanceof KnowledgeParseError && error.code === 'resource-limited',
  );
});

test('media mode defers ready images once a batch would pass the byte budget', async () => {
  const large = storedPng(1400);
  assert.ok(large.length > 6 * 1024 * 1024 && large.length <= 8 * 1024 * 1024, `${large.length}`);
  const names = ['a', 'b', 'c', 'd'];
  const bytes = zip(names.map(name => [`word/media/${name}.png`, large]));
  const { header, media } = await readKnowledgeMedia(
    input(bytes, 'docx'),
    names.map((name, index) => ({
      id: `m${index + 1}`,
      kind: 'image',
      ref: { kind: 'part', path: `word/media/${name}.png` },
    })),
  );
  assert.deepEqual(
    header.items.map(item => item.status),
    ['ready', 'ready', 'ready', 'deferred'],
  );
  assert.equal(media.length, 3);
});
