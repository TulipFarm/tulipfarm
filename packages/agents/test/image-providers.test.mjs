import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelCallError } from '@tulipfarm/observability';
import {
  imageHttpRequest,
  imageProviderRoute,
  readImageResponse,
  requestProviderImage,
} from '../src/image-providers.ts';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBase64 = Buffer.from(png).toString('base64');
const source = { bytes: png, mediaType: 'image/png', name: 'cat.png' };
const prompt = 'A tulip field at dawn';
const routes = {
  openai: {
    api: 'openai-images',
    provider: 'openai',
    endpoint: 'https://api.openai.com/',
    model: 'gpt-image-1',
    apiKey: 'sk-openai',
    timeoutMs: 5000,
  },
  azure: {
    api: 'openai-images',
    provider: 'azure',
    endpoint: 'https://tulip.openai.azure.com/',
    model: 'gpt-image-1',
    auth: { kind: 'api-key', value: 'azure-key' },
    timeoutMs: 5000,
  },
  compatible: {
    api: 'openai-images',
    provider: 'openai-compatible',
    endpoint: 'https://images.example.com/v1/',
    model: 'flux',
    apiKey: 'compatible-key',
    timeoutMs: 5000,
  },
  xai: {
    api: 'xai-images',
    provider: 'xai',
    endpoint: 'https://api.x.ai/',
    model: 'grok-imagine-image',
    apiKey: 'xai-key',
    timeoutMs: 5000,
  },
  gemini: {
    api: 'gemini-images',
    provider: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/',
    model: 'gemini-2.5-flash-image',
    apiKey: 'gemini-key',
    timeoutMs: 5000,
  },
};

test('OpenAI generations send one PNG request as JSON', () => {
  const http = imageHttpRequest(routes.openai, { prompt, size: '1024x1536', quality: 'high', sources: [] });
  assert.equal(http.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(http.headers.authorization, 'Bearer sk-openai');
  assert.deepEqual(JSON.parse(http.body), {
    model: 'gpt-image-1',
    prompt,
    n: 1,
    size: '1024x1536',
    quality: 'high',
    output_format: 'png',
  });
});

test('OpenAI edits send sources as multipart image[] parts', async () => {
  const http = imageHttpRequest(routes.openai, {
    prompt,
    size: '1024x1024',
    quality: 'standard',
    sources: [source, { ...source, name: 'dog.png' }],
  });
  assert.equal(http.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(http.headers['content-type'], undefined, 'fetch sets the multipart boundary');
  assert.ok(http.body instanceof FormData);
  assert.deepEqual(
    [...http.body.entries()].filter(([, value]) => typeof value === 'string'),
    [
      ['model', 'gpt-image-1'],
      ['prompt', prompt],
      ['n', '1'],
      ['size', '1024x1024'],
      ['quality', 'medium'],
      ['output_format', 'png'],
    ],
  );
  const images = http.body.getAll('image[]');
  assert.deepEqual(
    images.map(image => image.name),
    ['cat.png', 'dog.png'],
  );
  assert.deepEqual(new Uint8Array(await images[0].arrayBuffer()), png);
});

test('Azure and OpenAI-compatible routes use their own base and credential', () => {
  const azure = imageHttpRequest(routes.azure, { prompt, size: '1024x1024', quality: 'standard', sources: [] });
  assert.equal(azure.url, 'https://tulip.openai.azure.com/openai/v1/images/generations');
  assert.equal(azure.headers['api-key'], 'azure-key');
  assert.equal(JSON.parse(azure.body).model, 'gpt-image-1');
  const compatible = imageHttpRequest(routes.compatible, {
    prompt,
    size: '1024x1024',
    quality: 'standard',
    sources: [source],
  });
  assert.equal(compatible.url, 'https://images.example.com/v1/images/edits');
  assert.equal(compatible.headers.authorization, 'Bearer compatible-key');
});

test('xAI sends JSON with an aspect ratio, a resolution and data URL sources', () => {
  const generation = imageHttpRequest(routes.xai, { prompt, size: '16:9', quality: 'high', sources: [] });
  assert.equal(generation.url, 'https://api.x.ai/v1/images/generations');
  assert.deepEqual(JSON.parse(generation.body), {
    model: 'grok-imagine-image',
    prompt,
    n: 1,
    response_format: 'b64_json',
    aspect_ratio: '16:9',
    resolution: '2k',
  });
  const single = JSON.parse(
    imageHttpRequest(routes.xai, { prompt, size: '1:1', quality: 'standard', sources: [source] }).body,
  );
  assert.deepEqual(single.image, { url: `data:image/png;base64,${pngBase64}`, type: 'image_url' });
  assert.equal(single.resolution, '1k');
  const several = imageHttpRequest(routes.xai, { prompt, size: '1:1', quality: 'standard', sources: [source, source] });
  assert.equal(several.url, 'https://api.x.ai/v1/images/edits');
  assert.equal(JSON.parse(several.body).images.length, 2);
});

test('Gemini sends one generateContent call with inline sources and an aspect ratio', () => {
  const http = imageHttpRequest(routes.gemini, { prompt, size: '3:4', quality: 'high', sources: [source] });
  assert.equal(
    http.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
  );
  assert.equal(http.headers['x-goog-api-key'], 'gemini-key');
  assert.deepEqual(JSON.parse(http.body), {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: pngBase64 } }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } },
  });
});

test('responses read into an image with usage, a refusal, or nothing', () => {
  assert.deepEqual(
    readImageResponse('openai-images', {
      data: [{ b64_json: pngBase64 }],
      usage: { input_tokens: 12, output_tokens: 4160 },
    }),
    { kind: 'image', bytes: Buffer.from(png), mediaType: 'image/png', usage: { kind: 'known', input: 12, output: 4160 } },
  );
  assert.deepEqual(readImageResponse('xai-images', { data: [{ b64_json: pngBase64, mime_type: 'image/jpeg' }] }), {
    kind: 'image',
    bytes: Buffer.from(png),
    mediaType: 'image/jpeg',
    usage: { kind: 'unknown' },
  });
  const gemini = readImageResponse('gemini-images', {
    candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: pngBase64 } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 },
  });
  assert.equal(gemini.kind, 'image');
  assert.deepEqual(gemini.usage, { kind: 'known', input: 10, output: 1290 });
  assert.equal(readImageResponse('gemini-images', { promptFeedback: { blockReason: 'SAFETY' } }).kind, 'refused');
  assert.equal(
    readImageResponse('gemini-images', { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }).kind,
    'refused',
  );
  assert.equal(readImageResponse('gemini-images', { candidates: [{ finishReason: 'STOP' }] }), null);
  assert.equal(readImageResponse('openai-images', { data: [] }), null);
});

test('a moderation rejection is an unbilled refusal without provider text; other errors throw', async t => {
  const replies = [
    new Response(
      JSON.stringify({ error: { code: 'moderation_blocked', message: 'Your request was rejected: secret detail' } }),
      { status: 400 },
    ),
    new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'bad size' } }), { status: 400 }),
  ];
  t.mock.method(globalThis, 'fetch', async () => replies.shift());
  const refused = await requestProviderImage(routes.openai, { prompt, size: '1024x1024', quality: 'standard', sources: [] });
  assert.deepEqual(refused, { kind: 'refused', usage: { kind: 'unknown' } });
  await assert.rejects(
    requestProviderImage(routes.openai, { prompt, size: '1024x1024', quality: 'standard', sources: [] }),
    ModelCallError,
  );
});

test('a route needs its credential and never uses Anthropic', () => {
  const model = {
    route: {
      type: 'openai',
      api: 'openai-images',
      endpoint: 'https://api.openai.com/',
      model: 'gpt-image-1',
      apiKeyEnv: 'IMAGE_TEST_KEY',
    },
  };
  assert.equal(imageProviderRoute(model, {}), null);
  assert.equal(imageProviderRoute(model, { IMAGE_TEST_KEY: 'key' })?.apiKey, 'key');
  assert.equal(
    imageProviderRoute({ route: { ...model.route, type: 'anthropic' } }, { IMAGE_TEST_KEY: 'key' }),
    null,
  );
});
