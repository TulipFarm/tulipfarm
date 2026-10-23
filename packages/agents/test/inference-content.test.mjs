import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithContent } from '../src/inference.ts';
import { formats, nativeReply, nativeRoutes } from './native-fixture.mjs';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const base64 = Buffer.from(png).toString('base64');
const content = [
  { type: 'text', text: 'Read this image.' },
  { type: 'image', mediaType: 'image/png', data: png },
];
const vision = format => ({ ...nativeRoutes[format], capabilities: { imageInput: true } });

const expectedUser = {
  anthropic: body => body.messages[0],
  azure: body => body.messages[1],
  responses: body => body.input[1],
  google: body => body.contents[0],
};
const expectedParts = {
  anthropic: {
    role: 'user',
    content: [
      { type: 'text', text: 'Read this image.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
    ],
  },
  azure: {
    role: 'user',
    content: [
      { type: 'text', text: 'Read this image.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
    ],
  },
  responses: {
    role: 'user',
    content: [
      { type: 'input_text', text: 'Read this image.' },
      { type: 'input_image', image_url: `data:image/png;base64,${base64}` },
    ],
  },
  google: {
    role: 'user',
    parts: [{ text: 'Read this image.' }, { inlineData: { mimeType: 'image/png', data: base64 } }],
  },
};

for (const format of formats)
  test(`${format} sends image parts in the user message and returns the answer`, async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json(nativeReply(format, { text: '{"status":"ok"}' }));
    });
    const metered = [];
    const result = await inferWithContent(vision(format), 'Transcribe the image.', content, {
      meter: async attempt => {
        metered.push(attempt.step);
        return async usage => metered.push(usage.kind);
      },
    });
    assert.deepEqual(result, { kind: 'answer', text: '{"status":"ok"}' });
    assert.deepEqual(metered, [0, 'known']);
    assert.equal(requests.length, 1);
    assert.deepEqual(expectedUser[format](requests[0]), expectedParts[format]);
    assert.match(JSON.stringify(requests[0]), /Transcribe the image\./);
    assert.equal(requests[0].tools, undefined);
  });

test('base64 image data is sent as given and invalid base64 is rejected before dispatch', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json(nativeReply('azure', { text: 'ok' }));
  });
  await inferWithContent(vision('azure'), 'Read.', [{ type: 'image', mediaType: 'image/jpeg', data: base64 }]);
  assert.deepEqual(requests[0].messages[1].content, [
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
  ]);
  await assert.rejects(
    inferWithContent(vision('azure'), 'Read.', [{ type: 'image', mediaType: 'image/png', data: 'not base64!' }]),
    /Image data must be base64/,
  );
  await assert.rejects(
    inferWithContent(vision('azure'), 'Read.', [{ type: 'image', mediaType: 'image/tiff', data: png }]),
    /Unsupported image media type/,
  );
  assert.equal(requests.length, 1);
});

test('a model without imageInput is never sent images', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No request expected'));
  await assert.rejects(inferWithContent(nativeRoutes.azure, 'Read.', content), /does not declare imageInput/);
});

test('refusals and content filters return refused; output limits return truncated', async t => {
  const replies = [
    {
      choices: [{ finish_reason: 'content_filter', message: { content: null } }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    },
    new Response(JSON.stringify({ error: { code: 'content_filter', message: 'Filtered' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
    {
      choices: [{ finish_reason: 'length', message: { content: '{"status":"ok","text":"abc' } }],
      usage: { prompt_tokens: 1, completion_tokens: 4096, total_tokens: 4097 },
    },
    {
      choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  t.mock.method(globalThis, 'fetch', async () => {
    const reply = replies.shift();
    return reply instanceof Response ? reply : Response.json(reply);
  });
  assert.deepEqual(await inferWithContent(vision('azure'), 'Read.', content), { kind: 'refused' });
  assert.deepEqual(await inferWithContent(vision('azure'), 'Read.', content), { kind: 'refused' });
  assert.deepEqual(await inferWithContent(vision('azure'), 'Read.', content), {
    kind: 'truncated',
    text: '{"status":"ok","text":"abc',
  });
  assert.deepEqual(await inferWithContent(vision('azure'), 'Read.', content), { kind: 'refused' });
});

test('an unreadable response and an aborted request throw', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.signal.aborted) throw options.signal.reason;
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null } }] });
  });
  await assert.rejects(inferWithContent(vision('azure'), 'Read.', content), /model-invalid-decision/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    inferWithContent(vision('azure'), 'Read.', content, { signal: controller.signal }),
    /model-timeout/,
  );
});
