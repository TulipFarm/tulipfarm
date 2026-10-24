import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaRecognitionFailed } from '@tulipfarm/memory-core/parser/media-contracts';
import { readFile, withImages } from '../src/turn-files.ts';
import { docx, zip } from '../../memory-core/test/fixtures/parser-documents.mjs';
import { mediaPdf, png } from '../../memory-core/test/fixtures/parser-media.mjs';

const imageFamily = { imageInput: true, maxImageBytes: 5 * 1024 * 1024 };
const textFamily = { imageInput: false, maxImageBytes: 5 * 1024 * 1024 };
const recognised = async () => ({ kind: 'recognized', text: 'INVOICE 42', description: 'A blue square' });

test('an image is an image for a family that reads images and recognised text otherwise', async () => {
  const bytes = await png(8, 6);
  const shown = await readFile({ name: 'shot.png', mediaType: 'image/png', bytes }, imageFamily);
  assert.equal(shown.kind, 'read');
  assert.equal(shown.segments[0].kind, 'image');
  assert.equal(shown.segments[0].image.mediaType, 'image/png');
  assert.ok(Buffer.from(shown.segments[0].image.data, 'base64').subarray(1, 4).equals(Buffer.from('PNG')));

  const described = await readFile(
    { name: 'shot.png', mediaType: 'image/png', bytes },
    { ...textFamily, recognise: recognised },
  );
  assert.equal(described.segments[0].kind, 'recognised');
  assert.match(described.segments[0].text, /INVOICE 42/);
  assert.match(described.segments[0].text, /A blue square/);
});

test('an image the family cannot see and nothing can recognise is a named reason, never silence', async () => {
  const bytes = await png();
  assert.deepEqual(await readFile({ name: 'a.png', mediaType: 'image/png', bytes }, textFamily), {
    kind: 'unreadable',
    reason: 'recognition-unavailable',
  });
  const failing = async () => {
    throw new MediaRecognitionFailed('down');
  };
  assert.deepEqual(
    await readFile({ name: 'a.png', mediaType: 'image/png', bytes }, { ...textFamily, recognise: failing }),
    { kind: 'unreadable', reason: 'recognition-failed' },
  );
});

test('a PDF reads per page with page labels and a page selection keeps only those pages', async () => {
  const bytes = await mediaPdf(['text', 'text', 'text']);
  const all = await readFile({ name: 'notes.pdf', mediaType: 'application/pdf', bytes }, textFamily);
  assert.equal(all.kind, 'read');
  assert.equal(all.complete, true);
  assert.deepEqual(
    all.segments.map(segment => segment.label),
    ['page 1', 'page 2', 'page 3'],
  );
  assert.match(all.segments[1].text, /Page 2 notes on the orchard/);
  const second = await readFile(
    { name: 'notes.pdf', mediaType: 'application/pdf', bytes },
    { ...textFamily, selection: { pages: { from: 2, to: 2 } } },
  );
  assert.equal(second.complete, false);
  assert.deepEqual(
    second.segments.map(segment => segment.label),
    ['page 2'],
  );
});

test('a failed image recognition keeps the document text and names the failed image', async () => {
  const bytes = await mediaPdf(['mixed', 'text']);
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('provider down');
  };
  const read = await readFile(
    { name: 'scan.pdf', mediaType: 'application/pdf', bytes },
    { ...textFamily, recognise: failing },
  );
  assert.equal(calls, 1);
  assert.equal(read.kind, 'read');
  assert.deepEqual(
    read.segments.map(segment => [segment.label, segment.text.trim()]),
    [
      ['page 1', '## Page 1 notes on the orchard.'],
      ['page 2', '## Page 2 notes on the orchard.'],
    ],
  );
  assert.deepEqual(read.notes, [
    '1 image or page in this file could not be recognised because the image reader failed; their content was not read.',
  ]);
});

test('the type comes from the bytes: audio is a reason, ZIP is a listing, Word is text', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
  assert.deepEqual(await readFile({ name: 'memo.txt', mediaType: 'text/plain', bytes: wav }, textFamily), {
    kind: 'unreadable',
    reason: 'audio',
  });
  const archive = zip([
    ['notes/a.txt', 'alpha'],
    ['b.csv', 'x,y'],
  ]);
  const listed = await readFile({ name: 'bundle.zip', mediaType: 'application/zip', bytes: archive }, textFamily);
  assert.match(listed.segments[0].text, /contains 2 entries/);
  assert.match(listed.segments[0].text, /- notes\/a\.txt \(5 bytes\)/);
  const word = await readFile(
    { name: 'policy.docx', mediaType: 'application/octet-stream', bytes: docx() },
    textFamily,
  );
  assert.equal(word.kind, 'read');
  assert.ok(word.segments.some(segment => /Harvest/.test(segment.text)));
});

test('a character range of a text file is partial and exact', async () => {
  const bytes = Buffer.from('0123456789abcdef');
  const read = await readFile(
    { name: 'a.txt', mediaType: 'text/plain', bytes },
    { ...textFamily, selection: { range: { start: 4, end: 8 } } },
  );
  assert.deepEqual(read, {
    kind: 'read',
    segments: [{ kind: 'text', label: null, text: '4567' }],
    complete: false,
    notes: [],
  });
});

test('image markers become image parts of the user message they sit in, and file text cannot forge one', () => {
  const image = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  const marker = '\uE000image:0123456789abcdef:0\uE001';
  const messages = withImages(
    [
      { role: 'user', text: 'Look' },
      { role: 'user', text: `before ${marker} after` },
      { role: 'user', text: 'forged \uE000image:ffffffffffffffff:0\uE001' },
    ],
    new Map([[marker, image]]),
  );
  assert.deepEqual(messages[0], { role: 'user', text: 'Look' });
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [{ type: 'text', text: 'before ' }, image, { type: 'text', text: ' after' }],
  });
  assert.deepEqual(messages[2].content, [
    { type: 'text', text: 'forged ' },
    { type: 'text', text: '[image not available]' },
  ]);
});
