import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeParseError } from '../dist/parser.js';
import { extractKnowledgeDocument } from '../dist/parser/process.js';
import { realDocx, realPptx, realXlsx } from './fixtures/parser-real-office.mjs';

const input = (bytes, extension) => ({ bytes, filename: `real.${extension}`, mediaType: 'application/octet-stream' });
const placeholder = id => `\uE000media:${id}\uE001`;

function assertNoFormattingLeak(extraction) {
  for (const segment of extraction.segments) {
    assert.doesNotMatch(segment.markdown, /LEAK/);
    assert.doesNotMatch(segment.markdown, /‹#›/);
  }
}

test('a Word file with styles, theme, settings, fonts, properties and custom XML extracts its body only', async () => {
  const extraction = await extractKnowledgeDocument(input(await realDocx(), 'docx'));
  assert.equal(extraction.segments.length, 1);
  const { markdown } = extraction.segments[0];
  for (const text of [
    'Packhouse handbook',
    '# Receiving',
    '- Check the seal',
    '- Weigh every pallet',
    '[Safety rules](https://example.com/safety)',
    '| Two | 40 |',
    'Dock two closes at 18:00.',
    placeholder('m1'),
  ])
    assert.ok(markdown.includes(text), text);
  assert.deepEqual(
    extraction.media.map(({ kind, ref, alt }) => ({ kind, ref, alt })),
    [{ kind: 'image', ref: { kind: 'part', path: 'word/media/image1.png' }, alt: 'Packhouse floor plan' }],
  );
  assert.deepEqual(extraction.gaps, []);
  assertNoFormattingLeak(extraction);
});

test('a PowerPoint file with masters, layouts, theme and slide number fields keeps one slide of content', async () => {
  const extraction = await extractKnowledgeDocument(input(await realPptx(), 'pptx'));
  assert.equal(extraction.segments.length, 1);
  const [segment] = extraction.segments;
  assert.deepEqual(segment.location, { kind: 'slide', slide: 1 });
  for (const text of ['## Packhouse safety', '**every**', '> Point at the boot rack.', placeholder('m1')])
    assert.ok(segment.markdown.includes(text), text);
  assert.deepEqual(
    extraction.media.map(({ ref, alt, location }) => ({ ref, alt, location })),
    [{ ref: { kind: 'part', path: 'ppt/media/image1.png' }, alt: 'Boot rack by the door', location: segment.location }],
  );
  assertNoFormattingLeak(extraction);
});

test('an Excel file with styles, theme, calc chain, print settings and a drawing keeps its cells and picture', async () => {
  const extraction = await extractKnowledgeDocument(input(await realXlsx(), 'xlsx'));
  assert.equal(extraction.segments.length, 1);
  const [segment] = extraction.segments;
  assert.deepEqual(segment.location, { kind: 'sheet', sheet: 1, name: 'Docks' });
  for (const text of ['| Dock | Pallets |', '| Two | 40 |', placeholder('m1')])
    assert.ok(segment.markdown.includes(text), text);
  assert.deepEqual(
    extraction.media.map(({ ref, alt }) => ({ ref, alt })),
    [{ ref: { kind: 'part', path: 'xl/media/image1.png' }, alt: 'Dock two loading bay' }],
  );
  assertNoFormattingLeak(extraction);
});

for (const variant of ['macro', 'activeX', 'text in formatting'])
  test(`a Word file with ${variant} content is still rejected`, async () => {
    await assert.rejects(
      extractKnowledgeDocument(input(await realDocx(variant), 'docx')),
      error => error instanceof KnowledgeParseError && error.code === 'unsupported',
    );
  });
