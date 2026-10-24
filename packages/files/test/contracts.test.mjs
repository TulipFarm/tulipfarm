import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileDetailsSchema, newFileSchema } from '../src/contracts.ts';

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

test('file details keep generation optional so details without it still parse', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const base = {
    item: {
      id,
      kind: 'file',
      name: 'Cat.png',
      parentId: null,
      creatorMembershipId: id,
      mediaType: 'image/png',
      size: 10,
      trashed: false,
      role: 'viewer',
    },
    owner: { membershipId: id, name: 'Ada' },
    path: [],
    pathRestricted: false,
  };
  assert.equal(fileDetailsSchema.parse(base).generation, undefined);
  assert.equal(fileDetailsSchema.parse({ ...base, generation: null }).generation, null);
  const generation = {
    prompt: 'A cat',
    imageModelId: 'openai/gpt-image-1',
    catalogRevision: null,
    origin: { kind: 'turn', conversationId: id, turnId: id },
    sources: [{ kind: 'file', id }],
    hiddenSources: 2,
  };
  assert.deepEqual(fileDetailsSchema.parse({ ...base, generation }).generation, generation);
  assert.equal(
    fileDetailsSchema.safeParse({ ...base, generation: { ...generation, hiddenSources: -1 } }).success,
    false,
  );
});
