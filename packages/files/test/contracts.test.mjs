import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newFileSchema } from '../src/contracts.ts';

test('file creation validates names and rejects client-supplied ownership', () => {
  assert.deepEqual(newFileSchema.parse({ name: ' Report.txt ', parentId: null, mediaType: 'text/plain' }), {
    name: 'Report.txt',
    parentId: null,
    mediaType: 'text/plain',
  });
  for (const name of ['../file', 'file\\name', '\nfile', '\ud800', ' ']) {
    assert.equal(newFileSchema.safeParse({ name, parentId: null, mediaType: 'text/plain' }).success, false);
  }
  assert.equal(
    newFileSchema.safeParse({ name: 'file', parentId: null, mediaType: 'text/plain', owner: 'other-person' }).success,
    false,
  );
});
