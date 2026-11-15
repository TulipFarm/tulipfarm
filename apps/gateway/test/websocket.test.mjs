import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameCursor } from '../src/websocket.ts';

const between = (cursor, chunks) =>
  chunks.map(chunk => {
    cursor.read(Buffer.from(chunk));
    return cursor.between;
  });

test('a frame with a 16-bit length is between frames only after its last payload byte', () => {
  const payload = Array(300).fill(0x61);
  assert.deepEqual(between(frameCursor(), [[0x82], [0x7e, 0x01], [0x2c, ...payload.slice(0, 299)], [payload[299]]]), [
    false,
    false,
    false,
    true,
  ]);
});

test('a masked frame with a 64-bit length and the next frame in one chunk', () => {
  const cursor = frameCursor();
  const header = [0x82, 0xff, 0, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4];
  assert.deepEqual(between(cursor, [[...header, 9, 9], [9, 0x81, 0x01], [0x62]]), [false, false, true]);
  assert.equal(cursor.closed, false);
});

test('a close frame ends the stream', () => {
  const cursor = frameCursor();
  cursor.read(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
  assert.equal(cursor.between, true);
  assert.equal(cursor.closed, true);
});
