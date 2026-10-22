import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptSlices, transcriptChunks } from '../dist/memory/transcript.js';

test('transcript slices preserve Unicode code points and their exact original bytes', () => {
  const text = '🌷abc'.repeat(1000);
  const slices = transcriptSlices(text, 9);
  assert.equal(slices.join(''), text);
  for (const slice of slices) {
    assert.ok(Buffer.byteLength(slice) <= 9);
    assert.equal(Buffer.from(slice).toString('utf8'), slice);
  }
  assert.deepEqual(transcriptSlices('', 9), ['']);
});

test('oversized transcripts retain every numbered slice, message ID, and requester role', () => {
  const text = '🌷'.repeat(2000);
  const chunks = transcriptChunks([{ id: 'request-id', role: 'user', text }], 1400);
  assert.ok(chunks.length > 1);
  const bodies = [];
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(Buffer.byteLength(chunk) <= 1400);
    assert.ok(chunk.startsWith(`<message id="request-id" role="requester" part="${index + 1}/${chunks.length}">`));
    bodies.push(chunk.slice(chunk.indexOf('\n') + 1, chunk.lastIndexOf('\n</message>')));
  }
  assert.equal(bodies.join(''), text);
  assert.deepEqual(transcriptChunks([], 1400), []);
});
