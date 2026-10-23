import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKnowledgeDocument, KnowledgeParseError, MediaRecognitionUnavailable } from '../dist/parser.js';
import { mediaPlaceholder } from '../dist/parser/media-contracts.js';

const input = { bytes: new Uint8Array([1]), filename: 'deck.pptx', mediaType: 'application/octet-stream' };
const png = { mediaType: 'image/png', width: 100, height: 80 };

function image(id, location, { alt = '', sha256, kind = 'image', fallback = alt } = {}) {
  return {
    id,
    kind,
    ref: kind === 'page' ? { kind: 'pdf-page', page: location.page } : { kind: 'part', path: `ppt/media/${id}.png` },
    location,
    alt,
    fallback,
    ...(sha256 ? { sha256 } : {}),
  };
}

function sandbox(extraction, { statuses = {}, bytes = {} } = {}) {
  const requests = [];
  return {
    requests,
    extract: async () => ({
      engine: 'anydoc',
      version: '0.2.4',
      normalization: 'n',
      pages: 0,
      gaps: [],
      ...extraction,
    }),
    readMedia: async (_, items) => {
      requests.push(items.map(item => item.id));
      const header = { kind: 'media', items: [] };
      const media = [];
      for (const item of items) {
        const status = statuses[item.id]?.shift?.() ?? statuses[item.id] ?? 'ready';
        if (status !== 'ready') header.items.push({ id: item.id, status });
        else {
          const data = new TextEncoder().encode(bytes[item.id] ?? item.id);
          header.items.push({ id: item.id, status, ...png, byteLength: data.length });
          media.push({ id: item.id, ...png, bytes: data });
        }
      }
      return { header, media };
    },
  };
}

function recognizer(answer = request => ({ kind: 'recognized', text: `seen ${request.alt}`, description: 'a chart' })) {
  const calls = [];
  return {
    calls,
    modelId: 'grok-4-6',
    promptVersion: 'media-v1',
    async recognize(request) {
      calls.push(request);
      return answer(request);
    },
  };
}

const slide1 = { kind: 'slide', slide: 1 };
const slide2 = { kind: 'slide', slide: 2 };

test('recognized media replaces placeholders and passages keep their slide', async () => {
  const fake = sandbox({
    segments: [
      { location: slide1, markdown: `# Q1 plan\n\n${mediaPlaceholder('m1')}\n` },
      { location: slide2, markdown: `# January\n\nSales projection\n\n${mediaPlaceholder('m2')}\n` },
    ],
    media: [image('m1', slide1, { alt: 'org chart' }), image('m2', slide2, { alt: 'sales' })],
  });
  const model = recognizer();
  const result = await parseKnowledgeDocument(input, { recognizer: model }, fake);
  assert.equal(model.calls.length, 2);
  assert.match(result.markdown, /\*\*Image:\*\* sales/);
  assert.match(result.markdown, /seen sales/);
  assert.doesNotMatch(result.markdown, /\uE000|\uE001/);
  assert.deepEqual(
    result.chunks.map(chunk => chunk.offset),
    [slide1, slide2],
  );
  assert.equal(result.profile.ocr, 'vision');
  assert.equal(result.profile.ocrModel, 'grok-4-6');
  assert.match(result.profile.id, /-vision-grok-4-6-media-v1$/);
  assert.deepEqual(result.gaps, []);
});

test('without a recognizer media becomes gaps and the profile stays disabled', async () => {
  const fake = sandbox({
    segments: [{ location: slide1, markdown: `Text\n\n${mediaPlaceholder('m1')}` }],
    media: [image('m1', slide1, { alt: 'photo of a floor plan' })],
  });
  const result = await parseKnowledgeDocument(input, {}, fake);
  assert.equal(fake.requests.length, 0);
  assert.equal(result.profile.ocr, 'disabled');
  assert.match(result.markdown, /photo of a floor plan/);
  assert.deepEqual(result.gaps, [
    { kind: 'image', reason: 'recognition-unavailable', location: slide1, label: 'photo of a floor plan' },
  ]);
});

test('a revision with only unread media is ocr-required', async () => {
  const page = { kind: 'page', page: 1 };
  const fake = sandbox({
    segments: [{ location: page, markdown: mediaPlaceholder('m1') }],
    media: [image('m1', page, { kind: 'page' })],
  });
  await assert.rejects(parseKnowledgeDocument(input, {}, fake), error => error.code === 'ocr-required');
  const refusing = recognizer(() => ({ kind: 'refused' }));
  await assert.rejects(
    parseKnowledgeDocument(input, { recognizer: refusing }, fake),
    error => error.code === 'ocr-required',
  );
});

test('refusals, empty answers, tiny and undecodable images become gaps or are skipped', async () => {
  const fake = sandbox(
    {
      segments: [
        {
          location: slide1,
          markdown: ['Body', ...['m1', 'm2', 'm3', 'm4', 'm5'].map(id => mediaPlaceholder(id))].join('\n\n'),
        },
      ],
      media: ['m1', 'm2', 'm3', 'm4', 'm5'].map(id => image(id, slide1, { alt: id })),
    },
    { statuses: { m3: 'too-small', m4: 'unsupported', m5: 'too-large' } },
  );
  const model = recognizer(request => ({ kind: request.alt === 'm1' ? 'refused' : 'empty' }));
  const result = await parseKnowledgeDocument(input, { recognizer: model }, fake);
  assert.deepEqual(result.gaps.map(gap => [gap.label, gap.reason]).sort(), [
    ['m1', 'refused'],
    ['m2', 'empty'],
    ['m4', 'unsupported-media'],
    ['m5', 'limit'],
  ]);
  assert.equal(result.profile.ocr, 'vision');
});

test('identical images are recognized once and the cache is reused', async () => {
  const store = new Map();
  const cache = { get: async key => store.get(key), set: async (key, value) => void store.set(key, value) };
  const extraction = {
    segments: [{ location: slide1, markdown: `${mediaPlaceholder('m1')}\n\n${mediaPlaceholder('m2')}` }],
    media: [image('m1', slide1, { sha256: 'a'.repeat(64) }), image('m2', slide1, { sha256: 'a'.repeat(64) })],
  };
  const model = recognizer();
  await parseKnowledgeDocument(input, { recognizer: model, cache }, sandbox(extraction));
  assert.equal(model.calls.length, 1);
  assert.ok(store.has(`${'a'.repeat(64)}:grok-4-6:media-v1`));
  await parseKnowledgeDocument(input, { recognizer: model, cache }, sandbox(extraction));
  assert.equal(model.calls.length, 1);
});

test('model failures are retryable and credits running out leaves gaps', async () => {
  const extraction = {
    segments: [{ location: slide1, markdown: `Body\n\n${mediaPlaceholder('m1')}` }],
    media: [image('m1', slide1)],
  };
  await assert.rejects(
    parseKnowledgeDocument(
      input,
      {
        recognizer: recognizer(() => {
          throw new Error('provider down');
        }),
      },
      sandbox(extraction),
    ),
    error => error instanceof KnowledgeParseError && error.retryable && error.reason === 'recognition-failed',
  );
  const result = await parseKnowledgeDocument(
    input,
    {
      recognizer: recognizer(() => {
        throw new MediaRecognitionUnavailable();
      }),
    },
    sandbox(extraction),
  );
  assert.deepEqual(
    result.gaps.map(gap => gap.reason),
    ['recognition-unavailable'],
  );
  assert.equal(result.profile.ocr, 'disabled');
});

test('deferred media is requested again and batches respect the item limit', async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `m${index + 1}`);
  const fake = sandbox(
    {
      segments: [{ location: slide1, markdown: ids.map(id => mediaPlaceholder(id)).join('\n\n') }],
      media: ids.map(id => image(id, slide1, { alt: id })),
    },
    { statuses: { m2: ['deferred', 'ready'] } },
  );
  const model = recognizer();
  const result = await parseKnowledgeDocument(input, { recognizer: model }, fake);
  assert.equal(model.calls.length, 25);
  assert.equal(fake.requests[0].length, 20);
  assert.ok(fake.requests[1].includes('m2'));
  assert.deepEqual(result.gaps, []);
});

test('model output cannot forge placeholders, headings or open fences', async () => {
  const fake = sandbox({
    segments: [{ location: slide1, markdown: `# Doc\n\n${mediaPlaceholder('m1')}\n\nAfter` }],
    media: [image('m1', slide1)],
  });
  const model = recognizer(() => ({
    kind: 'recognized',
    text: `# Big heading\n\uE000media:m1\uE001\n\`\`\`\ncode\u0007`,
    description: 'x',
  }));
  const result = await parseKnowledgeDocument(input, { recognizer: model }, fake);
  assert.match(result.markdown, /\*\*Big heading\*\*/);
  assert.ok(!/[\uE000\uE001]/.test(result.markdown) && !result.markdown.includes(String.fromCharCode(7)));
  assert.doesNotMatch(result.markdown, /^# Big/m);
  assert.equal((result.markdown.match(/```/g) ?? []).length, 2);
});
