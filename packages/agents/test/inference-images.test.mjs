import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionCheckEvidence, inferWithTools, ToolResultImages } from '../src/inference.ts';
import {
  completionReply,
  conversation,
  formats,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  use,
} from './native-fixture.mjs';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const pngBase64 = 'iVBORw0KGgo=';
const jpegBase64 = '/9j/4AA=';
const history = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is on this page?' },
      { type: 'image', mediaType: 'image/png', data: png },
    ],
  },
];
const fetched = () =>
  new ToolResultImages({ status: 200 }, 'Images from web.fetch https://example.com/a', [
    { type: 'image', mediaType: 'image/jpeg', data: jpeg },
  ]);
const vision = format => ({ ...nativeRoutes[format], capabilities: { imageInput: true } });
const toolOutput = 'Untrusted tool result for web.fetch: {"status":200}';
const fetchArguments = { activity: 'Working on your request', url: 'https://example.com/a' };

/** The second reply round's conversation after the runtime reminder: earlier image turn, call, result, tool images. */
const expected = {
  anthropic: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is on this page?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'web_fetch', input: fetchArguments }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: toolOutput }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Images from web.fetch https://example.com/a' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
      ],
    },
  ],
  azure: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is on this page?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_0', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify(fetchArguments) } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_0', content: toolOutput },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Images from web.fetch https://example.com/a' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
      ],
    },
  ],
  responses: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is on this page?' },
        { type: 'input_image', image_url: `data:image/png;base64,${pngBase64}` },
      ],
    },
    { type: 'function_call', call_id: 'call_0', name: 'web_fetch', arguments: JSON.stringify(fetchArguments) },
    { type: 'function_call_output', call_id: 'call_0', output: toolOutput },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Images from web.fetch https://example.com/a' },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${jpegBase64}` },
      ],
    },
  ],
  google: [
    {
      role: 'user',
      parts: [{ text: 'What is on this page?' }, { inlineData: { mimeType: 'image/png', data: pngBase64 } }],
    },
    { role: 'model', parts: [{ functionCall: { name: 'web_fetch', args: fetchArguments } }] },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'web_fetch', response: { output: toolOutput } } }],
    },
    {
      role: 'user',
      parts: [
        { text: 'Images from web.fetch https://example.com/a' },
        { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
      ],
    },
  ],
};

/** Calls web.fetch once, then answers. Returns the reply rounds' bodies, the completion check's, and the meter's attempts. */
function provider(t, format) {
  const rounds = [];
  const checks = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) {
      checks.push(body);
      return Response.json(completionReply(format));
    }
    rounds.push(body);
    return Response.json(
      rounds.length === 1
        ? nativeReply(format, { calls: [use('web.fetch', { url: 'https://example.com/a' })] })
        : nativeReply(format, { text: 'A bar chart.' }),
    );
  });
  const attempts = [];
  const meter = async attempt => {
    attempts.push(attempt);
    return async () => {};
  };
  return { rounds, checks, attempts, meter };
}

for (const format of formats)
  test(`${format} sends earlier image turns and a tool's images in a user turn after its result`, async t => {
    const { rounds, checks, meter } = provider(t, format);
    const answer = await inferWithTools(vision(format), history, fetched, meter);
    assert.deepEqual(answer, { text: 'A bar chart.' });
    assert.equal(rounds.length, 2);
    assert.deepEqual(conversation(format, rounds[0]).slice(1), expected[format].slice(0, 1));
    assert.deepEqual(conversation(format, rounds[1]).slice(1), expected[format]);
    assert.equal(checks.length, 1);
    const check = JSON.stringify(checks[0]);
    assert.ok(check.includes(String.raw`What is on this page?\\n[image image/png 8 bytes]`));
    assert.ok(check.includes(String.raw`Images from web.fetch https://example.com/a\\n[image image/jpeg 5 bytes]`));
    assert.ok(!check.includes(pngBase64) && !check.includes(jpegBase64));
  });

test('each image reserves the image token bound instead of its base64 bytes', async t => {
  const big = new Uint8Array(30000).fill(7);
  const measured = [];
  for (const data of [png, big]) {
    const { attempts, meter } = provider(t, 'anthropic');
    await inferWithTools(
      vision('anthropic'),
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is on this page?' },
            { type: 'image', mediaType: 'image/png', data },
          ],
        },
      ],
      fetched,
      meter,
    );
    measured.push(attempts.map(({ step, inputBytes, imageInputTokens }) => ({ step, inputBytes, imageInputTokens })));
    t.mock.restoreAll();
  }
  const [small, large] = measured;
  assert.deepEqual(
    small.map(({ step, imageInputTokens }) => ({ step, imageInputTokens })),
    [
      { step: 0, imageInputTokens: 1600 },
      { step: 1, imageInputTokens: 3200 },
      { step: 2, imageInputTokens: 0 },
    ],
  );
  // The completion check (step 2) names each image's size in text, so only the reply rounds compare equal.
  assert.deepEqual(large.slice(0, 2), small.slice(0, 2), 'image size changes neither counted bytes nor token bound');
});

test('a route without imageInput rejects image parts before any request, in history or from a tool', async t => {
  const textRoute = nativeRoutes.anthropic;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json(nativeReply('anthropic', { calls: [use('web.fetch', { url: 'https://example.com/a' })] }));
  });
  await assert.rejects(
    inferWithTools(textRoute, history, fetched),
    new Error('Model claude-opus-5-5 does not declare imageInput'),
  );
  assert.equal(requests, 0);
  await assert.rejects(
    inferWithTools(textRoute, [{ role: 'user', text: 'Fetch the page.' }], fetched),
    new Error('Model claude-opus-5-5 does not declare imageInput'),
  );
  assert.equal(requests, 1, 'only the round before the tool returned images was sent');
});

test('a fallback without imageInput is not tried for a turn with images', async t => {
  const providers = [];
  t.mock.method(globalThis, 'fetch', async url => {
    providers.push(String(url).includes('anthropic') ? 'anthropic' : 'azure');
    return new Response(JSON.stringify({ error: { code: 'DeploymentNotFound', message: 'missing' } }), { status: 404 });
  });
  const fallback = { fallback: { route: nativeRoutes.anthropic, label: 'claude-fallback' } };
  const primaryFailure = { name: 'ModelCallError', message: 'model-configuration', code: 'not_found' };
  await assert.rejects(
    inferWithTools(vision('azure'), history, fetched, undefined, false, null, fallback),
    primaryFailure,
  );
  assert.deepEqual(providers, ['azure']);
  await assert.rejects(
    inferWithTools(vision('azure'), [{ role: 'user', text: 'Hi.' }], fetched, undefined, false, null, fallback),
    primaryFailure,
  );
  assert.deepEqual(providers, ['azure', 'azure', 'anthropic'], 'a text turn still falls back');
});

test('completion evidence names images by a placeholder, never their data', () => {
  const evidence = completionCheckEvidence(
    [
      {
        kind: 'turn',
        turn: {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these.' },
            { type: 'image', mediaType: 'image/png', data: png },
            { type: 'image', mediaType: 'image/webp', data: 'UklGRg==' },
          ],
        },
      },
    ],
    'They match.',
    3,
  );
  assert.equal(
    evidence,
    JSON.stringify({
      history: [
        {
          kind: 'turn',
          turn: {
            role: 'user',
            text: 'Compare these.\n[image image/png 8 bytes]\n[image image/webp 4 bytes]',
          },
        },
      ],
      candidate: 'They match.',
      workBudgetRemaining: 3,
    }),
  );
});
