import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTaskFiles } from '../src/task-files.ts';

const scope = {
  workspaceId: '6f1c2b8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  userId: 'u1',
  membershipId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
  taskId: '0b0e7a51-3c5d-4b8e-9f21-6d2a7c4e1f00',
};
const clipId = '3c9f0d2e-7b1a-4e5f-9a8b-2c1d0e9f8a7b';

function read(uploadable) {
  return readTaskFiles({
    reading: {
      enabled: async () => true,
      files: {
        download: async () => ({
          id: clipId,
          name: 'clip.mp4',
          mediaType: 'video/mp4',
          bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
        }),
      },
      recognition: async () => ({ recognition: undefined, maxImageBytes: 0 }),
    },
    scope,
    family: { imageInput: false, maxInputTokens: 100_000, imageInputTokens: 0, maxImageBytes: 0 },
    sources: [{ kind: 'file', fileId: clipId }],
    instructions: [],
    uploadable,
    withinAllowance: () => true,
  });
}

test('An attached file a run cannot read is kept for browser uploads, and stops a run that cannot upload', async () => {
  const kept = await read([clipId]);
  assert.deepEqual(kept.receipts, [], 'its contents were not read');
  const text = kept.content.map(part => part.text ?? '').join('');
  assert.match(text, /upload it into a website with browser\.upload/);
  assert.match(text, new RegExp(`file-id="${clipId}"[^>]*status="unreadable"`));

  const stop = { stop: { kind: 'unreadable', name: 'clip.mp4', reason: 'unsupported' } };
  assert.deepEqual(await read([]), stop);
  assert.deepEqual(await read(['7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d']), stop, 'only the listed files are exempt');
});

test("A task's own screenshot reaches the agent as an image, and a file it cannot read is skipped", async () => {
  const shotId = '5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716';
  const goneId = '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b';
  const clipRowId = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
  const tableId = '7c6b5a49-3827-4615-9a4b-3c2d1e0f9a8b';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  );
  const rowFiles = {
    [shotId]: { filename: 'bug.png', mediaType: 'image/png', size: png.byteLength, bytes: new Uint8Array(png) },
    [clipRowId]: {
      filename: 'clip.mp4',
      mediaType: 'video/mp4',
      size: 8,
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    },
  };
  const result = await readTaskFiles({
    reading: {
      rowFiles: { read: async (_workspace, _user, id) => rowFiles[id] ?? null },
      recognition: async () => ({ recognition: undefined, maxImageBytes: 5_000_000 }),
    },
    scope,
    family: { imageInput: true, maxInputTokens: 100_000, imageInputTokens: 1500, maxImageBytes: 5_000_000 },
    sources: [shotId, goneId, clipRowId].map(attachmentId => ({ kind: 'row-attachment', tableId, attachmentId })),
    instructions: [],
    withinAllowance: () => true,
  });
  assert.ok(!('stop' in result), 'a missing or unreadable task file does not pause the run');
  assert.ok(
    result.content.some(part => part.type === 'image'),
    'the screenshot is an image part',
  );
  const text = result.content.map(part => part.text ?? '').join('');
  assert.match(text, /bug\.png/);
  assert.doesNotMatch(text, /clip\.mp4/);
});
