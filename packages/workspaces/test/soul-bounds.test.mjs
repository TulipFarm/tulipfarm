import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { initializeSoul, readSoulObject } from '../src/soul.ts';

const seed = {
  workspaceId: 'a9fc9f32-8787-4b81-9962-c834e2a8fe51',
  createdBy: 'a6b75a33-4245-432b-a615-4d5fa9aa646a',
  createdAt: '2026-09-27T12:00:00.000Z',
};

test('starter cancels a stream that exceeds its declared size before buffering its remaining chunks', async () => {
  let consumed = 0;
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        consumed++;
        if (consumed > 100) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const storage = {
    bucket: 'soul-test',
    client: {
      async send() {
        return {
          ContentLength: 751,
          Metadata: { sha256: '0'.repeat(64) },
          Body: {
            transformToWebStream: () => body,
            async transformToByteArray() {
              const chunks = [];
              for await (const chunk of body) chunks.push(chunk);
              return Buffer.concat(chunks);
            },
          },
        };
      },
    },
  };
  await assert.rejects(initializeSoul(storage, seed), /size/);
  assert.equal(cancelled, true);
  assert.equal(consumed, 1);
});

test('shared reader rejects invalid declarations without consuming the stream', async () => {
  for (const ContentLength of [undefined, 0, -1, 1.5, NaN, Infinity, 1025]) {
    let consumed = false;
    let cancelled = false;
    const body = new ReadableStream(
      {
        pull() {
          consumed = true;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const storage = {
      bucket: 'test',
      client: {
        async send() {
          return { ContentLength, Body: { transformToWebStream: () => body } };
        },
      },
    };
    await assert.rejects(readSoulObject(storage, 'key', 1024), /size/);
    assert.equal(consumed, false);
    assert.equal(cancelled, true);
  }
});

test('shared reader verifies exact lengths, checksums and metadata after bounded consumption', async () => {
  const bytes = Buffer.from('verified');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  function storage(ContentLength, Metadata) {
    return {
      bucket: 'test',
      client: {
        async send() {
          return {
            ContentLength,
            Metadata,
            Body: {
              transformToWebStream: () =>
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                  },
                }),
            },
          };
        },
      },
    };
  }
  await assert.rejects(readSoulObject(storage(bytes.length + 1, { sha256 }), 'key', 1024), /checksum/);
  await assert.rejects(readSoulObject(storage(bytes.length, { sha256: '0'.repeat(64) }), 'key', 1024), /checksum/);
  await assert.rejects(
    readSoulObject(storage(bytes.length, { sha256 }), 'key', 1024, sha256, { 'command-sha256': sha256 }),
    /metadata/,
  );
  assert.deepEqual(
    await readSoulObject(storage(bytes.length, { sha256, 'command-sha256': sha256 }), 'key', 1024, sha256, {
      'command-sha256': sha256,
    }),
    bytes,
  );
});
