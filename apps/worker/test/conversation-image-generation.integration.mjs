import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { creditUnitsForProviderCost } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createAttachments } from '../../../packages/conversations/src/attachments.ts';
import { generateImageOutputs } from '../../../packages/conversations/src/image-outputs.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { pinnedImageChoice } from '../../../packages/agents/src/image-generation.ts';
import { createFiles } from '../../../packages/files/src/index.ts';
import { png } from '../../../packages/memory-core/test/fixtures/parser-media.mjs';
import { createConversationActivities } from '../src/conversation-activities.ts';
import {
  anthropicText,
  anthropicTools,
  completionReply,
  isCompletionRequest,
  isTitleRequest,
  toolResults,
} from './native-chat-fixture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const chatModel = (id, imageModel, extra = {}) => ({
  ...shipped.models.find(entry => entry.id === id),
  default: false,
  imageModel,
  ...extra,
});
const aspects = { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' };
const ratios = { square: '1:1', portrait: '3:4', landscape: '16:9' };
const perImage = (square, other) => ({
  usdPerImage: {
    standard: { square, portrait: other, landscape: other },
    high: { square: square * 4, portrait: other * 4, landscape: other * 4 },
  },
});
// One chat family per image API: Sonnet draws with OpenAI, Haiku with xAI, Opus with Gemini.
const catalog = JSON.stringify({
  ...shipped,
  models: [
    chatModel('claude-sonnet', 'gpt-image', { default: true }),
    chatModel('claude-haiku', 'grok-image'),
    chatModel('claude-opus', 'nano-image'),
  ],
  imageModels: [
    {
      id: 'gpt-image',
      name: 'GPT Image',
      vendor: 'openai',
      routes: [{ provider: 'openai', model: 'gpt-image-1', api: 'openai-images' }],
      edits: true,
      maxSources: 4,
      aspects,
      pricing: perImage(0.04, 0.06),
    },
    {
      id: 'grok-image',
      name: 'Grok Imagine',
      vendor: 'xai',
      routes: [{ provider: 'xai', model: 'grok-imagine-image', api: 'xai-images' }],
      edits: true,
      maxSources: 1,
      aspects: ratios,
      pricing: perImage(0.07, 0.07),
    },
    {
      id: 'nano-image',
      name: 'Nano Banana',
      vendor: 'google',
      routes: [{ provider: 'google', model: 'gemini-2.5-flash-image', api: 'gemini-images' }],
      edits: false,
      aspects: ratios,
      pricing: [{ usdPerMillionTokens: { input: 0.3, output: 30 } }],
    },
  ],
});

/** A PNG with a `caBX` chunk after IHDR, where PNG files carry C2PA content credentials. */
async function signedPng(color = '#2a7') {
  const plain = Buffer.from(await png(16, 16, color));
  const data = Buffer.from('c2pa manifest store');
  const type = Buffer.from('caBX');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([plain.subarray(0, 33), length, type, data, crc, plain.subarray(33)]);
}

function memoryBytes() {
  const objects = new Map();
  return {
    putIfAbsent: async (key, body) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
    },
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  };
}

const imageHosts = ['api.openai.com', 'api.x.ai', 'generativelanguage.googleapis.com'];

/**
 * A chat whose model follows `script`, one entry per model step: a list of images.generate calls (run as one step),
 * or text. Image providers answer through `draw`, which sees the provider, the request and its signal.
 */
async function setup(t, { flag = 'true' } = {}) {
  const f = await conversationFixture();
  const keys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'XAI_API_KEY',
    'GEMINI_API_KEY',
    'MODEL_CATALOG',
    'MODEL_CATALOG_FILE',
    'FEATURE_FLAG_IMAGES',
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'synthetic-test-key',
    OPENAI_API_KEY: 'openai-test-key',
    XAI_API_KEY: 'xai-test-key',
    GEMINI_API_KEY: 'gemini-test-key',
    MODEL_CATALOG: catalog,
    FEATURE_FLAG_IMAGES: flag,
  });
  delete process.env.MODEL_CATALOG_FILE;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await f.close();
  });
  const state = { script: [], chat: [], images: [], draw: undefined, onImage: undefined };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const host = new URL(url).host;
    if (imageHosts.includes(host)) {
      const request = {
        host,
        url: String(url),
        headers: options.headers,
        body: options.body instanceof FormData ? options.body : JSON.parse(options.body),
      };
      state.images.push(request);
      await state.onImage?.(request);
      return state.draw(request, options.signal);
    }
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    if (isTitleRequest(body)) return Response.json(anthropicText('Images'));
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    if (JSON.stringify(body.system ?? '').includes('You read one image'))
      return Response.json(anthropicText(JSON.stringify({ status: 'ok', text: '', description: 'A photo' })));
    state.chat.push(body);
    const next = state.script.shift() ?? 'Done.';
    return Response.json(
      typeof next === 'string'
        ? anthropicText(next)
        : anthropicTools(next.map(call => ({ tool: 'images.generate', ...call }))),
    );
  });
  const attachmentBytes = memoryBytes();
  const attachments = createAttachments(f.runtime, attachmentBytes);
  const files = createFiles(f.runtime, memoryBytes());
  const w = f.workspace;
  const chat = async (user = w.userId) => {
    const chatId = randomUUID();
    await f.store.create(w.id, user, { chatId, commandId: randomUUID() });
    return chatId;
  };
  const attach = async (chatId, filename, bytes, user = w.userId) => {
    const id = randomUUID();
    await attachments.reserve(w.id, user, chatId, id, {
      filename,
      mediaType: 'image/png',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await attachments.upload(w.id, user, chatId, id, bytes);
    return id;
  };
  /** Sends one message and runs its reply as the worker does; returns the tool results the model saw, parsed. */
  const turn = async (chatId, script, familyId = 'claude-sonnet', text = 'Draw it.', parts = []) => {
    state.script = [...script];
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: familyId,
      parts: [...parts, { kind: 'text', text }],
    });
    const from = state.chat.length;
    const status = await createConversationActivities(
      f.runtime,
      undefined,
      { attachments: attachmentBytes, snapshots: attachmentBytes },
      undefined,
      files,
    ).processConversationReply({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    assert.equal(status, 'completed');
    const last = state.chat.at(-1);
    // The last request carries every tool result of the turn, in order.
    return {
      turnId: sent.turnId,
      requests: state.chat.slice(from),
      results: (last && state.chat.length > from ? toolResults(last) : []).map(content => {
        const raw = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
        const text = raw.replace(/^Untrusted tool result for [a-z.]+: /, '');
        if (text.startsWith('Invalid arguments')) return { error: 'invalid-request', text };
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }),
    };
  };
  const rows = async sql => (await f.db.platform.query(sql)).rows;
  const imageUsage = () =>
    rows(
      `SELECT id,flow_id,activity,reserved::text,charged::text,provider_pico_usd::text FROM ${f.table('tf_credit_usage')} WHERE id LIKE 'image:%' ORDER BY created_at`,
    );
  const generations = () =>
    rows(
      `SELECT id,origin_kind,origin_id,conversation_id,ordinal,state,failure,prompt,image_model_id,catalog_revision,sources FROM ${f.table('tf_image_generations')} ORDER BY created_at,ordinal`,
    );
  const membership = async () =>
    (await f.db.platform.query(`SELECT id FROM ${f.table('tf_memberships')} WHERE user_id=$1`, [w.userId])).rows[0].id;
  return { ...f, w, files, chat, attach, turn, state, rows, imageUsage, generations, membership };
}

const openAiImage = bytes =>
  Response.json({
    data: [{ b64_json: Buffer.from(bytes).toString('base64') }],
    usage: { input_tokens: 20, output_tokens: 4160 },
  });

test(
  'OpenAI images are saved unchanged in Files, shown pending then saved, and charged at provider cost',
  { timeout: 120000 },
  async t => {
    const f = await setup(t);
    const drawn = [await signedPng('#a22'), await signedPng('#22a')];
    let pendingSeen;
    f.state.onImage = async () => {
      if (pendingSeen) return;
      const history = await f.store.history(f.w.id, f.w.userId, chatId);
      const tool = history.messages.flatMap(message => message.tools ?? []).find(t => t.tool === 'images.generate');
      pendingSeen = tool?.images?.map(image => image.state);
    };
    f.state.draw = async () => openAiImage(drawn.shift());
    const chatId = await f.chat();
    const { turnId, results } = await f.turn(chatId, [
      [{ prompt: 'Two tulip posters', count: 2, preset: 'instagram-feed', quality: 'standard', name: 'Poster' }],
      'Here are your posters.',
    ]);

    assert.deepEqual(
      f.state.images.map(request => ({ url: request.url, auth: request.headers.authorization, body: request.body })),
      Array.from({ length: 2 }, () => ({
        url: 'https://api.openai.com/v1/images/generations',
        auth: 'Bearer openai-test-key',
        body: {
          model: 'gpt-image-1',
          prompt: 'Two tulip posters',
          n: 1,
          size: '1024x1536',
          quality: 'medium',
          output_format: 'png',
        },
      })),
    );
    const [result] = results;
    assert.deepEqual(
      result.images.map(image => ({ state: image.state, name: image.file.name, parentId: image.file.parentId })),
      [
        { state: 'saved', name: 'Poster 1.png', parentId: null },
        { state: 'saved', name: 'Poster 2.png', parentId: null },
      ],
    );
    assert.ok(
      pendingSeen?.every(state => state === 'pending'),
      `pending before the first image: ${pendingSeen}`,
    );

    // C2PA bytes are kept: each saved file is one of the provider's answers, unchanged. Images run concurrently, so
    // which answer lands on which index is not fixed.
    const expected = [await signedPng('#a22'), await signedPng('#22a')].map(bytes => bytes.toString('base64'));
    const saved = [];
    for (const image of result.images) {
      const file = await f.files.download(f.w.id, f.w.userId, image.id);
      assert.equal(file.mediaType, 'image/png');
      assert.ok(Buffer.from(file.bytes).includes(Buffer.from('caBX')));
      saved.push(Buffer.from(file.bytes).toString('base64'));
    }
    assert.deepEqual(saved.toSorted(), expected.toSorted(), 'the saved bytes are the provider bytes');

    const rows = await f.generations();
    assert.deepEqual(
      rows.map(row => ({ ...row, catalog_revision: typeof row.catalog_revision })),
      result.images.map((image, ordinal) => ({
        id: image.id,
        origin_kind: 'turn',
        origin_id: turnId,
        conversation_id: chatId,
        ordinal,
        state: 'saved',
        failure: null,
        prompt: 'Two tulip posters',
        image_model_id: 'gpt-image',
        catalog_revision: 'string',
        sources: [],
      })),
    );

    // The card reads the generation rows: saved after the call.
    const history = await f.store.history(f.w.id, f.w.userId, chatId);
    const receipt = history.messages.flatMap(message => message.tools ?? []).find(t => t.tool === 'images.generate');
    assert.deepEqual(
      receipt.images,
      result.images.map(image => ({ index: image.index, id: image.id, state: 'saved' })),
    );

    // Each image held the most it can cost and settled at the provider price, $0.06, in the chat's flow.
    const usage = await f.imageUsage();
    assert.equal(usage.length, 2);
    for (const row of usage) {
      assert.equal(row.flow_id, chatId);
      assert.equal(row.activity, 'chat');
      assert.equal(row.provider_pico_usd, '60000000000');
      assert.equal(row.reserved, creditUnitsForProviderCost(60000000000n).toString());
      assert.notEqual(row.charged, null);
    }
    const flow = (
      await f.rows(
        `SELECT sum(provider_pico_usd)::text AS cost, sum(charged)::text AS charged FROM ${f.table('tf_credit_usage')} WHERE flow_id='${chatId}'`,
      )
    )[0];
    assert.equal(flow.charged, creditUnitsForProviderCost(BigInt(flow.cost)).toString(), 'rounded once per flow');
  },
);

test('xAI edits send the attachment and Files sources, and an unreadable source is refused before any charge', async t => {
  const f = await setup(t);
  const drawn = await signedPng();
  f.state.draw = async () => Response.json({ data: [{ b64_json: drawn.toString('base64'), mime_type: 'image/png' }] });
  const source = await png(8, 8, '#0a0');
  const chatId = await f.chat();
  const attachmentId = await f.attach(chatId, 'photo.png', source);
  const other = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    randomUUID(),
    other,
  ]);
  const hidden = await f.files.upload(
    f.w.id,
    other,
    randomUUID(),
    { name: 'private.png', parentId: null, mediaType: 'image/png' },
    source,
  );
  const { results } = await f.turn(
    chatId,
    [
      [{ prompt: 'Make it blue', aspect: 'landscape', quality: 'high', sources: [attachmentId] }],
      [{ prompt: 'Use their photo', sources: [hidden.id] }],
      [{ prompt: 'Combine', sources: [attachmentId, attachmentId, randomUUID()] }],
      'Edited.',
    ],
    'claude-haiku',
    'Edit this',
    [{ kind: 'attachment', attachmentId }],
  );
  assert.equal(f.state.images.length, 1);
  assert.deepEqual(f.state.images[0].body, {
    model: 'grok-imagine-image',
    prompt: 'Make it blue',
    n: 1,
    response_format: 'b64_json',
    aspect_ratio: '16:9',
    resolution: '2k',
    image: { url: `data:image/png;base64,${Buffer.from(source).toString('base64')}`, type: 'image_url' },
  });
  assert.equal(f.state.images[0].url, 'https://api.x.ai/v1/images/edits');
  assert.equal(results[0].images[0].state, 'saved');
  assert.equal(results[1].error, 'source-unreadable');
  assert.equal(results[2].error, 'image-edit-unsupported', 'Grok takes one source');
  const [row] = await f.generations();
  assert.deepEqual(row.sources, [
    { kind: 'attachment', id: attachmentId, sha256: createHash('sha256').update(source).digest('hex') },
  ]);
  assert.equal((await f.imageUsage()).length, 1, 'refused calls hold no credits');
});

test('Gemini sends a generateContent call and settles at its token rates', async t => {
  const f = await setup(t);
  const drawn = await signedPng();
  f.state.draw = async () =>
    Response.json({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: drawn.toString('base64') } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 },
    });
  const chatId = await f.chat();
  const { results } = await f.turn(
    chatId,
    [[{ prompt: 'A tulip', aspect: 'portrait' }], [{ prompt: 'Edit', sources: [randomUUID()] }], 'Done.'],
    'claude-opus',
  );
  assert.deepEqual(f.state.images[0].body, {
    contents: [{ role: 'user', parts: [{ text: 'A tulip' }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } },
  });
  assert.equal(
    f.state.images[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
  );
  assert.equal(results[0].images[0].state, 'saved');
  assert.equal(results[1].error, 'image-edit-unsupported', 'Nano Banana is not configured for edits here');
  const [usage] = await f.imageUsage();
  // 10 input tokens at $0.30/M and 1290 output tokens at $30/M.
  assert.equal(usage.provider_pico_usd, String(10 * 300000 + 1290 * 30000000));
});

test('an unavailable image model names a family that can generate, and a turned-off setting says so', async t => {
  const f = await setup(t);
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_model_availability')} (family_id,enabled,revision,last_disabled_revision,editor_membership_id) VALUES ('grok-image',false,1,1,$1)`,
    [await f.membership()],
  );
  const chatId = await f.chat();
  const first = await f.turn(chatId, [[{ prompt: 'A tulip' }], 'Sorry.'], 'claude-haiku');
  assert.equal(first.results[0].error, 'image-model-unavailable');
  assert.equal(first.results[0].alternativeFamilyId, 'claude-sonnet');
  assert.match(first.results[0].instruction, /claude-sonnet model can generate images/);

  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_image_settings')} (generation_enabled,revision,editor_membership_id) VALUES (false,1,$1)`,
    [await f.membership()],
  );
  const second = await f.turn(chatId, [[{ prompt: 'A tulip' }], 'Sorry.'], 'claude-sonnet');
  assert.equal(second.results[0].error, 'image-model-unavailable');
  assert.match(second.results[0].instruction, /turned off/);
  assert.equal(f.state.images.length, 0);
  assert.deepEqual(await f.imageUsage(), []);
});

test('a turn makes at most 8 images and bad calls fail before any provider call or charge', async t => {
  const f = await setup(t);
  f.state.draw = async () => openAiImage(await signedPng());
  const chatId = await f.chat();
  const { results } = await f.turn(chatId, [
    [{ prompt: 'Tulips', count: 3 }],
    [{ prompt: 'More tulips', count: 5 }],
    [{ prompt: 'Tulips', aspect: 'square', preset: 'instagram-feed' }],
    [{ prompt: 'Tulips', folderId: randomUUID() }],
    [{ prompt: 'Tulips', count: 3, name: 'Second' }],
    [{ prompt: 'Tulips', count: 3, quality: 'high', name: 'Third' }],
    [{ prompt: 'Tulips', count: 2, name: 'Fourth' }],
    [{ prompt: 'Tulips', name: 'Ninth' }],
    'Done.',
  ]);
  assert.deepEqual(
    results.map(result => result.error ?? result.images.map(image => image.state).join(',')),
    [
      'saved,saved,saved',
      'invalid-request',
      'invalid-request',
      'destination-required',
      'saved,saved,saved',
      'image-limit-exceeded',
      'saved,saved',
      'image-limit-exceeded',
    ],
  );
  assert.equal(results[5].remaining, 2);
  assert.equal(results[7].remaining, 0);
  assert.match(results[7].instruction, /already generated 8 images/);
  assert.equal(f.state.images.length, 8);
  assert.equal((await f.imageUsage()).length, 8, 'refused calls hold no credits');
  assert.equal((await f.rows(`SELECT id FROM ${f.table('tf_files')} WHERE kind='file'`)).length, 8);
});

test('a provider refusal is not charged and returns no provider text', async t => {
  const f = await setup(t);
  f.state.draw = async () =>
    Response.json(
      { error: { code: 'moderation_blocked', message: 'Rejected by the safety system: secret reason' } },
      { status: 400 },
    );
  const chatId = await f.chat();
  const { results, requests } = await f.turn(chatId, [[{ prompt: 'Something refused' }], 'It was refused.']);
  assert.equal(results[0].error, 'content-refused');
  assert.deepEqual(
    results[0].images.map(image => [image.state, image.failure]),
    [['refused', 'content-refused']],
  );
  assert.ok(!JSON.stringify(requests.at(-1)).includes('secret reason'));
  const [usage] = await f.imageUsage();
  assert.equal(usage.charged, '0');
  assert.equal(usage.provider_pico_usd, '0');
  assert.deepEqual(await f.rows(`SELECT id FROM ${f.table('tf_files')} WHERE kind='file'`), []);
});

test('with the images flag off, images.generate is not a tool and nothing is generated', async t => {
  const f = await setup(t, { flag: 'false' });
  const chatId = await f.chat();
  const { results, requests } = await f.turn(chatId, [[{ prompt: 'A tulip' }], 'I cannot.']);
  assert.ok(requests.every(request => !JSON.stringify(request.tools ?? []).includes('images_generate')));
  assert.ok(typeof results[0] === 'string' || !('images' in results[0]));
  assert.match(JSON.stringify(results[0]), /Unknown tool|not available|not permitted/i);
  assert.equal(f.state.images.length, 0);
  assert.deepEqual(await f.imageUsage(), []);
});

test('stopping mid-batch cancels unfinished images and keeps the saved one and its charge', async t => {
  const f = await setup(t);
  const controller = new AbortController();
  const drawn = await signedPng();
  let calls = 0;
  f.state.draw = async (_request, signal) => {
    if (++calls === 1) {
      setTimeout(() => controller.abort(), 200);
      return openAiImage(drawn);
    }
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }),
    );
  };
  const w = f.w;
  const actor = { kind: 'human', userId: w.userId, membershipId: await f.membership() };
  const transaction = operation => f.runtime.transaction(w.id, commonCompatibility, operation);
  const chosen = await transaction(tx =>
    pinnedImageChoice(tx, { familyId: 'claude-sonnet', imageModelId: 'gpt-image', catalogRevision: 'test' }),
  );
  const result = await generateImageOutputs(
    { files: f.files, transaction },
    {
      workspaceId: w.id,
      actor,
      autonomous: false,
      origin: { kind: 'run', runId: randomUUID() },
      model: chosen.model,
      generate: chosen.generate,
      credits: { flowId: randomUUID(), activity: 'agent', agentId: null },
      signal: controller.signal,
    },
    { tool: 'images.generate', prompt: 'Three tulips', count: 3 },
  );
  assert.deepEqual(result.images.map(image => image.state).sort(), ['cancelled', 'cancelled', 'saved']);
  const usage = await f.imageUsage();
  assert.deepEqual(usage.map(row => row.provider_pico_usd).sort(), ['0', '0', '40000000000']);
  assert.equal((await f.rows(`SELECT id FROM ${f.table('tf_files')} WHERE kind='file'`)).length, 1);
});

test('a repeated call returns the stored files without a second provider call or charge', async t => {
  const f = await setup(t);
  let fail = true;
  f.state.draw = async () => {
    if (fail) {
      fail = false;
      return Response.json({ error: { message: 'overloaded' } }, { status: 500 });
    }
    return openAiImage(await signedPng());
  };
  const w = f.w;
  const actor = { kind: 'human', userId: w.userId, membershipId: await f.membership() };
  const transaction = operation => f.runtime.transaction(w.id, commonCompatibility, operation);
  const chosen = await transaction(tx =>
    pinnedImageChoice(tx, { familyId: 'claude-sonnet', imageModelId: 'gpt-image', catalogRevision: 'test' }),
  );
  const origin = { kind: 'run', runId: randomUUID() };
  const flowId = randomUUID();
  const run = () =>
    generateImageOutputs(
      { files: f.files, transaction },
      {
        workspaceId: w.id,
        actor,
        autonomous: false,
        origin,
        model: chosen.model,
        generate: chosen.generate,
        credits: { flowId, activity: 'agent', agentId: null },
      },
      { tool: 'images.generate', prompt: 'Two tulips', count: 2 },
    );
  const first = await run();
  assert.deepEqual(first.images.map(image => image.state).sort(), ['failed', 'saved']);
  assert.equal(f.state.images.length, 2);

  // A failed image is tried again; the saved one is returned as it is.
  const second = await run();
  assert.deepEqual(
    second.images.map(image => image.state),
    ['saved', 'saved'],
  );
  assert.deepEqual(
    second.images.map(image => image.id),
    first.images.map(image => image.id),
  );
  assert.equal(f.state.images.length, 3);

  // With every image saved, a repeat makes no provider call and no charge.
  const charged = (await f.imageUsage()).length;
  const third = await run();
  assert.deepEqual(third.images, second.images);
  assert.equal(f.state.images.length, 3);
  assert.equal((await f.imageUsage()).length, charged);
  assert.equal((await f.rows(`SELECT id FROM ${f.table('tf_files')} WHERE kind='file'`)).length, 2);
});
