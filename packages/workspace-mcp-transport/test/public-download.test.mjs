import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicDownload } from '../src/public-download.ts';

test('downloads validate each redirect and cap redirects and streamed bytes', async () => {
  const seen = [];
  const download = createPublicDownload(async url => {
    seen.push(url);
    return seen.length === 1
      ? new Response(null, { status: 302, headers: { location: '/file' } })
      : new Response(Uint8Array.of(0, 255));
  });
  const result = await download('https://example.com/source', 2, AbortSignal.timeout(1000));
  assert.deepEqual([...result.bytes], [0, 255]);
  assert.equal(result.url, 'https://example.com/file');
  await assert.rejects(
    createPublicDownload(
      async () => new Response(null, { status: 302, headers: { location: 'http://localhost/private' } }),
    )('https://example.com', 10, AbortSignal.timeout(1000)),
    /endpoint-denied/,
  );
  await assert.rejects(
    createPublicDownload(async () => new Response(null, { status: 302, headers: { location: '/' } }))(
      'https://example.com',
      10,
      AbortSignal.timeout(1000),
    ),
    /redirect-denied/,
  );
  await assert.rejects(
    createPublicDownload(async () => new Response('long'))('https://example.com', 3, AbortSignal.timeout(1000)),
    /response-limit/,
  );
});
